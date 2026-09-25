using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program {
  [STAThread]
  private static void Main() {
    Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
    Application.ThreadException += (sender, args) => { WriteCrash(args.Exception); Application.Exit(); };
    AppDomain.CurrentDomain.UnhandledException += (sender, args) => WriteCrash(args.ExceptionObject as Exception);
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    Application.Run(new PnxWindow());
  }
  private static void WriteCrash(Exception error) {
    try {
      string root = Environment.GetEnvironmentVariable("PNX_DESKTOP_DATA_ROOT") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PnX Platform");
      Directory.CreateDirectory(root);
      File.AppendAllText(Path.Combine(root, "crash.log"), DateTime.UtcNow.ToString("o") + " " + error + Environment.NewLine);
    } catch { }
  }
}

internal sealed class PnxWindow : Form {
  private readonly WebView2 web = new WebView2();
  private readonly Label loading = new Label();
  private readonly string appRoot = AppDomain.CurrentDomain.BaseDirectory;
  private readonly string userRoot = SelectDataRoot();
  private readonly JavaScriptSerializer json = new JavaScriptSerializer();
  private Process server;
  private string origin;
  private string workspace;
  private string project;

  public PnxWindow() {
    Text = "PnX Platform";
    Width = 1500;
    Height = 950;
    MinimumSize = new Size(850, 650);
    BackColor = Color.FromArgb(24, 32, 45);
    web.Dock = DockStyle.Fill;
    Controls.Add(web);
    loading.Dock = DockStyle.Fill;
    loading.TextAlign = ContentAlignment.MiddleCenter;
    loading.ForeColor = Color.White;
    loading.Font = new Font("Microsoft YaHei", 12);
    loading.Text = "正在启动 PnX Platform…";
    Controls.Add(loading);
    loading.BringToFront();
    Directory.CreateDirectory(userRoot);
    workspace = ReadSetting("workspace.txt");
    project = ReadSetting("project.txt");
    Shown += async (sender, args) => await StartAsync();
    FormClosed += (sender, args) => StopServer();
  }

  private static string SelectDataRoot() {
    string selected = Environment.GetEnvironmentVariable("PNX_DESKTOP_DATA_ROOT");
    if (!String.IsNullOrEmpty(selected)) { Directory.CreateDirectory(selected); return selected; }
    string[] candidates = {
      Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PnX Platform"),
      Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".data")
    };
    foreach (string candidate in candidates) {
      try {
        Directory.CreateDirectory(candidate);
        string probe = Path.Combine(candidate, ".write-probe-" + Guid.NewGuid().ToString("N"));
        File.WriteAllText(probe, "ok");
        File.Delete(probe);
        return candidate;
      } catch (UnauthorizedAccessException) { } catch (IOException) { }
    }
    throw new IOException("无法写入用户数据目录或程序目录");
  }

  private string ReadSetting(string name) {
    string file = Path.Combine(userRoot, name);
    if (!File.Exists(file)) return null;
    string value = File.ReadAllText(file).Trim();
    return Directory.Exists(value) ? value : null;
  }

  private static bool IsPnx(string folder) {
    return !String.IsNullOrEmpty(folder)
      && File.Exists(Path.Combine(folder, "CMakePresets.json"))
      && Directory.Exists(Path.Combine(folder, "configs", "boards"));
  }

  private string FindProject() {
    if (IsPnx(project)) return project;
    return null;
  }

  private async Task StartAsync() {
    try {
      Trace("starting server");
      origin = await StartServerAsync();
      Trace("server ready " + origin);
      var options = new CoreWebView2EnvironmentOptions("--disable-gpu --disable-software-rasterizer --no-sandbox");
      var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(userRoot, "webview"), options);
      Trace("webview environment ready");
      await web.EnsureCoreWebView2Async(environment);
      Trace("webview control ready");
      web.CoreWebView2.Settings.AreDevToolsEnabled = true;
      web.CoreWebView2.NavigationStarting += (sender, args) => {
        Trace("navigation starting " + args.Uri);
        if (!args.Uri.StartsWith(origin, StringComparison.OrdinalIgnoreCase)) args.Cancel = true;
      };
      web.CoreWebView2.ProcessFailed += (sender, args) => {
        Trace("webview process failed " + args.ProcessFailedKind);
        if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) ShowError("WebView2 进程已退出，请查看 desktop.log");
      };
      web.CoreWebView2.WebMessageReceived += OnMessage;
      await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(@"
        window.PNXDesktop = { chooseFolder: () => new Promise(resolve => {
          window.__pnxFolderResolver = resolve;
          chrome.webview.postMessage('choose-folder');
        }) };
        chrome.webview.addEventListener('message', event => {
          if (event.data && Object.prototype.hasOwnProperty.call(event.data, 'folder')) {
            const resolve = window.__pnxFolderResolver;
            window.__pnxFolderResolver = null;
            if (resolve) resolve(event.data.folder);
          }
        });
      ");
      web.CoreWebView2.NavigationCompleted += (sender, args) => {
        Trace("navigation completed success=" + args.IsSuccess);
        loading.Visible = false;
        if (!args.IsSuccess) ShowError("页面加载失败：" + args.WebErrorStatus);
      };
      web.CoreWebView2.Navigate(origin);
      Trace("navigate requested");
    } catch (Exception error) {
      Trace("startup error " + error);
      ShowError("启动失败：" + error.Message);
      if (Environment.GetEnvironmentVariable("PNX_DESKTOP_TEST_MODE") != "1") MessageBox.Show(this, error.ToString(), "PnX Platform 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
  }

  private async Task<string> StartServerAsync() {
    string executable = Path.Combine(appRoot, "bin", "node.exe");
    string script = Path.Combine(appRoot, "src", "server.mjs");
    if (!File.Exists(executable) || !File.Exists(script)) throw new FileNotFoundException("缺少内置 Node.js 或后端服务文件");
    string template = FindProject();
    var start = new ProcessStartInfo(executable, "\"" + script + "\"");
    start.WorkingDirectory = appRoot;
    start.UseShellExecute = false;
    start.CreateNoWindow = true;
    start.RedirectStandardOutput = true;
    start.RedirectStandardError = true;
    Environment.SetEnvironmentVariable("PNX_WORKSPACE_ROOT", Directory.Exists(workspace) ? workspace : (template ?? ""), EnvironmentVariableTarget.Process);
    Environment.SetEnvironmentVariable("PNX_CACHE_ROOT", Path.Combine(userRoot, "cache"), EnvironmentVariableTarget.Process);
    var ready = new TaskCompletionSource<string>();
    var output = new StringBuilder();
    server = new Process();
    server.StartInfo = start;
    server.OutputDataReceived += (sender, args) => {
      if (args.Data == null) return;
      lock (output) output.AppendLine(args.Data);
      const string prefix = "PnX Platform: ";
      if (args.Data.StartsWith(prefix, StringComparison.Ordinal)) ready.TrySetResult(args.Data.Substring(prefix.Length).Trim());
    };
    server.ErrorDataReceived += (sender, args) => { if (args.Data != null) lock (output) output.AppendLine(args.Data); };
    server.Exited += (sender, args) => ready.TrySetException(new Exception("后端服务退出：" + output.ToString()));
    server.EnableRaisingEvents = true;
    if (!server.Start()) throw new Exception("无法启动后端服务");
    server.BeginOutputReadLine();
    server.BeginErrorReadLine();
    Task completed = await Task.WhenAny(ready.Task, Task.Delay(15000));
    if (completed != ready.Task) throw new TimeoutException("后端服务启动超时：" + output.ToString());
    return await ready.Task;
  }

  private void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args) {
    string message;
    try { message = args.TryGetWebMessageAsString(); } catch { return; }
    if (message != "choose-folder") return;
    string folder = null;
    using (var picker = new FolderBrowserDialog()) {
      picker.Description = "选择要打开的源码文件夹";
      picker.ShowNewFolderButton = false;
      if (Directory.Exists(workspace)) picker.SelectedPath = workspace;
      if (picker.ShowDialog(this) == DialogResult.OK) folder = picker.SelectedPath;
    }
    if (folder != null) {
      workspace = folder;
      File.WriteAllText(Path.Combine(userRoot, "workspace.txt"), folder);
      if (IsPnx(folder)) {
        project = folder;
        File.WriteAllText(Path.Combine(userRoot, "project.txt"), folder);
      }
    }
    web.CoreWebView2.PostWebMessageAsJson("{\"folder\":" + json.Serialize(folder) + "}");
  }

  private void ShowError(string message) {
    loading.Visible = true;
    loading.Text = message;
    loading.BringToFront();
  }

  private void Trace(string message) {
    try { File.AppendAllText(Path.Combine(userRoot, "desktop.log"), DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine); }
    catch { }
  }

  private void StopServer() {
    try { if (server != null && !server.HasExited) server.Kill(); }
    catch { }
    if (server != null) server.Dispose();
  }
}
