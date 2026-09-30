// Windows x64 experimental RC150 receiver. USB structures follow libusb-win32's
// byte-packed lusb0_usb.h. Decoder ABI was checked against the supplied BulletFluor.
// Only the original live-view keyframe request/cancel is sent to the DJI protocol port.
using System;
using System.IO;
using System.IO.Pipes;
using System.IO.Ports;
using Microsoft.Win32;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class PnxBulletReceiver {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibrary(string path);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool SetDllDirectory(string path);
  [DllImport("libusb0.dll", CallingConvention=CallingConvention.Cdecl)] static extern void usb_init();
  [DllImport("libusb0.dll", CallingConvention=CallingConvention.Cdecl)] static extern int usb_find_busses();
  [DllImport("libusb0.dll", CallingConvention=CallingConvention.Cdecl)] static extern int usb_find_devices();
  [DllImport("libusb0.dll", CallingConvention=CallingConvention.Cdecl)] static extern IntPtr usb_get_busses();
  [DllImport("libusb0.dll", CallingConvention=CallingConvention.Cdecl)] static extern IntPtr usb_open(IntPtr device);
  [DllImport("libusb0.dll", CallingConvention=CallingConvention.Cdecl)] static extern int usb_close(IntPtr device);
  [DllImport("libusb0.dll", CallingConvention=CallingConvention.Cdecl)] static extern int usb_claim_interface(IntPtr device, int index);
  [DllImport("libusb0.dll", CallingConvention=CallingConvention.Cdecl)] static extern int usb_release_interface(IntPtr device, int index);
  [DllImport("libusb0.dll", CallingConvention=CallingConvention.Cdecl)] static extern int usb_set_configuration(IntPtr device, int index);
  [DllImport("libusb0.dll", CallingConvention=CallingConvention.Cdecl)] static extern int usb_bulk_read(IntPtr device, int endpoint, byte[] bytes, int count, int timeout);
  [DllImport("libusb0.dll", CallingConvention=CallingConvention.Cdecl)] static extern IntPtr usb_strerror();
  [DllImport("RC150.dll", CallingConvention=CallingConvention.Cdecl)] static extern int RC150Init();
  [DllImport("RC150.dll", CallingConvention=CallingConvention.Cdecl)] static extern int StartDecodeThread();
  [DllImport("RC150.dll", CallingConvention=CallingConvention.Cdecl)] static extern int EndDecodeThread();
  [DllImport("RC150.dll", CallingConvention=CallingConvention.Cdecl)] static extern int RC150Release();
  [DllImport("RC150.dll", CallingConvention=CallingConvention.Cdecl)] static extern int OnRecvVideoStream(byte[] bytes, int count);
  [DllImport("RC150.dll", CallingConvention=CallingConvention.Cdecl)] static extern IntPtr GetCurrentFrameInfo(out int width, out int height);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int LogCallback(int level, [MarshalAs(UnmanagedType.LPStr)] string message);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void FrameRequestCallback();
  [DllImport("RC150.dll", CallingConvention=CallingConvention.Cdecl)] static extern void RegisterLogOutput(LogCallback callback);
  [DllImport("RC150.dll", CallingConvention=CallingConvention.Cdecl)] static extern void RegisterRequestIFrame(FrameRequestCallback callback);
  [DllImport("RC150.dll", CallingConvention=CallingConvention.Cdecl)] static extern void RegisterRequestCancelIFrame(FrameRequestCallback callback);
  // The decoder calls these unconditionally on some packet paths. Keep delegates rooted.
  static long lastLog;
  static readonly LogCallback nativeLog = delegate(int level, string message) {
    long now = DateTime.UtcNow.Ticks;
    if (now - Interlocked.Read(ref lastLog) > TimeSpan.FromSeconds(1).Ticks) { Interlocked.Exchange(ref lastLog, now); Console.Error.WriteLine("RC150 " + message); }
    return 0;
  };
  static int requested = 1;
  static volatile bool decoded;
  static readonly FrameRequestCallback keyframeRequest = delegate() { Interlocked.Exchange(ref requested, 1); };
  static readonly FrameRequestCallback keyframeCancel = delegate() { decoded = true; Interlocked.Exchange(ref requested, 0); };
  public static byte[] KeyframePacket(bool request) {
    byte[] packet = new byte[23];
    packet[0] = 0x55; packet[1] = 23; packet[2] = 4;
    byte crc8 = 0x77;
    for (int i = 0; i < 3; i++) { crc8 ^= packet[i]; for (int bit = 0; bit < 8; bit++) crc8 = (byte)((crc8 >> 1) ^ ((crc8 & 1) != 0 ? 0x8c : 0)); }
    packet[3] = crc8; packet[4] = 0xaa; packet[5] = 0x0e; packet[8] = 0x40; packet[9] = 1; packet[10] = 1;
    packet[16] = packet[20] = (byte)(request ? 0x24 : 4);
    ushort crc16 = 0x3692;
    for (int i = 0; i < 21; i++) { crc16 ^= packet[i]; for (int bit = 0; bit < 8; bit++) crc16 = (ushort)((crc16 >> 1) ^ ((crc16 & 1) != 0 ? 0x8408 : 0)); }
    packet[21] = (byte)crc16; packet[22] = (byte)(crc16 >> 8); return packet;
  }
  static SerialPort OpenProtocolPort() {
    var ports = new List<string>();
    using (var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\USB\VID_2CA3&PID_1020&MI_02")) {
      if (key != null) foreach (string instance in key.GetSubKeyNames()) {
        using (var parameters = key.OpenSubKey(instance + @"\Device Parameters")) {
          string port = parameters == null ? null : parameters.GetValue("PortName") as string;
          if (port != null && Array.IndexOf(SerialPort.GetPortNames(), port) >= 0 && !ports.Contains(port)) ports.Add(port);
        }
      }
    }
    if (ports.Count != 1) throw new Exception("Exactly one DJI MI_02 protocol port is required; found " + ports.Count + ".");
    var serial = new SerialPort(ports[0], 961200, Parity.None, 8, StopBits.One);
    serial.ReadTimeout = 300; serial.WriteTimeout = 300; serial.ReadBufferSize = 10240;
    try { serial.Open(); Thread.Sleep(300); return serial; } catch { serial.Dispose(); throw; }
  }
  static void Control(SerialPort port) {
    int previous = -1; long sent = 0;
    try {
      while (running) {
        int desired = Interlocked.CompareExchange(ref requested, 0, 0);
        if (desired != previous || (desired == 1 && DateTime.UtcNow.Ticks - sent > TimeSpan.FromMilliseconds(500).Ticks)) {
          byte[] packet = KeyframePacket(desired == 1); port.Write(packet, 0, packet.Length);
          previous = desired; sent = DateTime.UtcNow.Ticks;
        }
        if (port.BytesToRead > 0) port.DiscardInBuffer();
        Thread.Sleep(30);
      }
    } catch (Exception ex) { readError = "DJI protocol port: " + ex.Message; running = false; }
    finally { try { byte[] cancel = KeyframePacket(false); port.Write(cancel, 0, cancel.Length); } catch {} }
  }
  static void RegisterCallbacks() { RegisterLogOutput(nativeLog); RegisterRequestIFrame(keyframeRequest); RegisterRequestCancelIFrame(keyframeCancel); }
  static volatile bool running;
  static long lastBytes, totalBytes;
  static string readError;
  static void LoadUsb(string library) {
    if (IntPtr.Size != 8) throw new Exception("Windows x64 is required.");
    if (String.IsNullOrWhiteSpace(library)) library = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "libusb0.dll");
    if (LoadLibrary(library) == IntPtr.Zero)
      throw new Exception("Cannot load x64 libusb0.dll (error " + Marshal.GetLastWin32Error() + "). Select the manufacturer's x64 DLL; the USB driver must already be installed.");
    usb_init(); usb_find_busses(); usb_find_devices();
  }
  static Dictionary<string,IntPtr> Find(string library) {
    LoadUsb(library); var result = new Dictionary<string,IntPtr>();
    int count = 0;
    for (IntPtr bus = usb_get_busses(); bus != IntPtr.Zero; bus = Marshal.ReadIntPtr(bus)) {
      if (++count > 1000) throw new Exception("Invalid USB bus list.");
      // next + prev + char dirname[512], followed by devices (pack=1).
      for (IntPtr dev = Marshal.ReadIntPtr(bus, 2 * IntPtr.Size + 512); dev != IntPtr.Zero; dev = Marshal.ReadIntPtr(dev)) {
        if (++count > 10000) throw new Exception("Invalid USB device list.");
        int descriptor = 3 * IntPtr.Size + 512;
        int vid = (ushort)Marshal.ReadInt16(dev, descriptor + 8), pid = (ushort)Marshal.ReadInt16(dev, descriptor + 10);
        if (vid != 0x2ca3 || pid != 0x1020) continue;
        // The same composite device exposes another serial/control interface.
        // Only report configuration 1, interface 0 with bulk IN endpoint 0x81.
        IntPtr config = Marshal.ReadIntPtr(dev, descriptor + 18);
        if (config == IntPtr.Zero || Marshal.ReadByte(config, 5) != 1) continue;
        IntPtr interfaces = Marshal.ReadIntPtr(config, 9); bool videoInterface = false;
        int interfaceCount = Math.Min(32, (int)Marshal.ReadByte(config, 4));
        for (int i = 0; interfaces != IntPtr.Zero && i < interfaceCount; i++) {
          IntPtr alt = Marshal.ReadIntPtr(interfaces, i * (IntPtr.Size + 4));
          if (alt == IntPtr.Zero || Marshal.ReadByte(alt, 2) != 0) continue;
          IntPtr endpoints = Marshal.ReadIntPtr(alt, 9);
          int endpointCount = Math.Min(32, (int)Marshal.ReadByte(alt, 4));
          for (int j = 0; endpoints != IntPtr.Zero && j < endpointCount; j++) {
            IntPtr endpoint = IntPtr.Add(endpoints, j * (9 + IntPtr.Size + 4));
            if (Marshal.ReadByte(endpoint, 2) == 0x81 && (Marshal.ReadByte(endpoint, 3) & 3) == 2) videoInterface = true;
          }
        }
        if (!videoInterface) continue;
        byte[] filename = new byte[512]; Marshal.Copy(IntPtr.Add(dev, 2 * IntPtr.Size), filename, 0, 512);
        int end = Array.IndexOf(filename, (byte)0); if (end < 0) end = 512;
        result[Encoding.ASCII.GetString(filename, 0, end)] = dev;
      }
    }
    return result;
  }
  public static string[] Devices(string library) { return new List<string>(Find(library).Keys).ToArray(); }
  public static string CheckDecoder(string sdkDirectory) {
    SetDllDirectory(sdkDirectory);
    if (LoadLibrary(Path.Combine(sdkDirectory, "RC150.dll")) == IntPtr.Zero) throw new Exception("Cannot load RC150 dependencies: " + Marshal.GetLastWin32Error());
    RegisterCallbacks(); int initialized = RC150Init();
    try { int width, height; IntPtr frame = GetCurrentFrameInfo(out width, out height); return "init=" + initialized + "; frame=" + width + "x" + height + "; allocated=" + (frame != IntPtr.Zero); }
    finally { RC150Release(); }
  }
  static string UsbError() { return Marshal.PtrToStringAnsi(usb_strerror()) ?? "USB operation failed"; }
  static void ReadUsb(IntPtr device) {
    byte[] buffer = new byte[10240], work = new byte[10240];
    try {
      while (running) {
        int size = usb_bulk_read(device, 0x81, buffer, buffer.Length, 500);
        if (size == -116 || size == -110) continue; // libusb-win32 / POSIX timeout
        if (size < 0) throw new Exception("USB read: " + UsbError());
        if (size == 0) continue;
        Interlocked.Exchange(ref lastBytes, DateTime.UtcNow.Ticks); Interlocked.Add(ref totalBytes, size);
        int offset = 0;
        while (offset < size && running) {
          int remaining = size - offset; Buffer.BlockCopy(buffer, offset, work, 0, remaining);
          int consumed = OnRecvVideoStream(work, remaining);
          // Original receiver drops this transfer on decoder rejection and resumes at the next USB transfer.
          if (consumed <= 0) break;
          if (consumed > remaining) throw new Exception("RC150 returned an invalid consumed byte count.");
          offset += consumed;
        }
      }
    } catch (Exception ex) { readError = ex.Message; running = false; }
  }
  public static void Run(string sdkDirectory, string library, string selected, string pipeName) {
    if (Process.GetProcessesByName("FacgtoryTC").Length > 0 || Process.GetProcessesByName("ReceiveEnd").Length > 0)
      throw new Exception("Close BulletFluor / ReceiveEnd before connecting; the receiver needs exclusive access.");
    var devices = Find(library);
    if (!devices.ContainsKey(selected)) throw new Exception("Selected DJI receiver is no longer available. Refresh devices.");
    if (devices.Count != 1) throw new Exception("Connect only one DJI receiver so its protocol port can be identified unambiguously.");
    SetDllDirectory(sdkDirectory);
    if (LoadLibrary(Path.Combine(sdkDirectory, "RC150.dll")) == IntPtr.Zero)
      throw new Exception("Cannot load RC150.dll or its dependencies (error " + Marshal.GetLastWin32Error() + ").");
    IntPtr handle = IntPtr.Zero; bool claimed = false, initialized = false, decoder = false; Thread reader = null, control = null; SerialPort protocol = null;
    try {
      handle = usb_open(devices[selected]);
      if (handle == IntPtr.Zero) throw new Exception("Cannot open receiver: " + UsbError());
      if (usb_set_configuration(handle, 1) < 0) throw new Exception("Cannot select USB configuration: " + UsbError());
      if (usb_claim_interface(handle, 0) < 0) throw new Exception("Receiver interface is busy: " + UsbError());
      claimed = true;
      protocol = OpenProtocolPort(); decoded = false; requested = 1;
      RegisterCallbacks();
      if (RC150Init() != 1) throw new Exception("RC150 decoder initialization failed.");
      initialized = true; StartDecodeThread(); decoder = true;
      running = true; lastBytes = 0; totalBytes = 0; readError = null;
      control = new Thread(delegate() { Control(protocol); }); control.IsBackground = true; control.Start();
      reader = new Thread(delegate() { ReadUsb(handle); }); reader.IsBackground = true; reader.Start();
      using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out)) {
        pipe.Connect(5000);
        // Named pipe isolates binary frames from native DLL stdout/stderr logs.
        using (var writer = new BinaryWriter(pipe)) {
          var started = DateTime.UtcNow;
          Thread stop = new Thread(delegate() { Console.ReadLine(); running = false; }); stop.IsBackground = true; stop.Start();
          while (running) {
            long last = Interlocked.Read(ref lastBytes);
            if (last == 0 || DateTime.UtcNow.Ticks - last > TimeSpan.FromSeconds(3).Ticks) {
              if ((DateTime.UtcNow - started).TotalSeconds > 15) throw new Exception("No recent video packets. Check transmitter power, pairing and radio link.");
              Thread.Sleep(100); continue;
            }
            int width, height; IntPtr ptr = GetCurrentFrameInfo(out width, out height);
            if (!decoded) {
              if ((DateTime.UtcNow - started).TotalSeconds > 20) throw new Exception("Video packets received but no decoded keyframe. Check transmitter camera and radio link.");
              Thread.Sleep(100); continue;
            }
            if (ptr == IntPtr.Zero || width <= 0 || height <= 0) { Thread.Sleep(100); continue; }
            if (width > 3840 || height > 2160 || (long)width * height > 8294400) throw new Exception("Decoder returned invalid frame dimensions.");
            byte[] rgb = new byte[checked(width * height * 3)]; Marshal.Copy(ptr, rgb, 0, rgb.Length);
            writer.Write(0x31464250); writer.Write(width); writer.Write(height); writer.Write(rgb.Length); writer.Write(rgb); writer.Flush();
            Thread.Sleep(200);
          }
        }
      }
      if (readError != null) throw new Exception(readError);
    } finally {
      running = false;
      if (control != null) control.Join(1500);
      if (protocol != null) protocol.Dispose();
      if (reader != null && !reader.Join(2000)) Environment.Exit(2); // process owns all native resources
      if (decoder) EndDecodeThread(); if (initialized) RC150Release();
      if (claimed) usb_release_interface(handle, 0); if (handle != IntPtr.Zero) usb_close(handle);
    }
  }
}
