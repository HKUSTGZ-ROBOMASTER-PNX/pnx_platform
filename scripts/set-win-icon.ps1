param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$Icon)
$ErrorActionPreference = 'Stop'
if (-not ('PnxIconResource' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class PnxIconResource {
  delegate bool EnumName(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
  [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32", CharSet=CharSet.Unicode)] static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumName callback, IntPtr param);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResource(string path, bool delete);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool UpdateResource(IntPtr handle, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32", SetLastError=true)] static extern bool EndUpdateResource(IntPtr handle, bool discard);
  public static void Apply(string exe, string ico) {
    byte[] file=File.ReadAllBytes(ico);
    ushort count=BitConverter.ToUInt16(file,4);
    if (BitConverter.ToUInt16(file,2)!=1 || count==0) throw new InvalidDataException("Invalid ICO");
    var names=new List<int>();
    IntPtr module=LoadLibraryEx(exe,IntPtr.Zero,2);
    if(module==IntPtr.Zero) throw new Win32Exception();
    try { EnumResourceNames(module,(IntPtr)14,(m,t,n,p)=> { if(n.ToInt64()<=65535) names.Add(n.ToInt32()); return true; },IntPtr.Zero); }
    finally { FreeLibrary(module); }
    if(names.Count==0) names.Add(1);
    IntPtr h=BeginUpdateResource(exe,false);
    if(h==IntPtr.Zero) throw new Win32Exception();
    try {
      using(var stream=new MemoryStream()) using(var w=new BinaryWriter(stream)) {
        w.Write((ushort)0); w.Write((ushort)1); w.Write(count);
        for(int i=0;i<count;i++) {
          int e=6+i*16, size=BitConverter.ToInt32(file,e+8), offset=BitConverter.ToInt32(file,e+12);
          byte[] data=new byte[size]; Array.Copy(file,offset,data,0,size);
          if(!UpdateResource(h,(IntPtr)3,(IntPtr)(i+1),0,data,(uint)size)) throw new Win32Exception();
          w.Write(file,e,12); w.Write((ushort)(i+1));
        }
        byte[] group=stream.ToArray();
        foreach(int name in names) if(!UpdateResource(h,(IntPtr)14,(IntPtr)name,0,group,(uint)group.Length)) throw new Win32Exception();
      }
      if(!EndUpdateResource(h,false)) throw new Win32Exception();
      h=IntPtr.Zero;
    } finally { if(h!=IntPtr.Zero) EndUpdateResource(h,true); }
  }
}
'@
}
[PnxIconResource]::Apply((Resolve-Path -LiteralPath $Executable).Path, (Resolve-Path -LiteralPath $Icon).Path)
