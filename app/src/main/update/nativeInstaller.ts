export interface InstallerLaunch { userData: string; path: string; version: string; size: number; sha256: string }
export const NATIVE_INSTALLER = String.raw`
namespace KnuafUpdate {
 public static class Installer {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
   public uint cb; public string reserved,desktop,title;
   public uint x,y,width,height,xChars,yChars,fill,flags; public ushort show,reservedCount;
   public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern bool CreateProcess(string file,StringBuilder args,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Shell {
   public uint cb,mask; public IntPtr window; public string verb,file,args,directory; public int show;
   public IntPtr instance,idList; public string className; public IntPtr classKey; public uint hotKey; public IntPtr icon,process;
  }
  [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ShellExecuteEx(ref Shell info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr process);
  static Dictionary<string,object> Unknown() { return new Dictionary<string,object>{{"unknown",true}}; }
  static Dictionary<string,object> Started(int pid) { return pid>0 ? new Dictionary<string,object>{{"started",true},{"pid",pid}} : Unknown(); }
  public static Dictionary<string,object> Execute(string userData,string expectedPath,string version,long size,string sha) {
   bool attempted=false;
   try {
    using(var files=new Files(userData,false)) {
     string path=files.Target(version+"/installer.exe",false);
     if(!String.Equals(Path.GetFullPath(path),Path.GetFullPath(expectedPath),StringComparison.OrdinalIgnoreCase)) throw new IOException("Installer path mismatch");
     using(var file=files.Open(path)) {
      // Hash THIS handle; keep FILE_SHARE_READ (no write/delete) and EVERY ancestor pin
      // until CreateProcess or runas/UAC has returned a confirmed start/cancel/failure.
      if(!Files.Matches(file,size,sha)) throw new IOException("Installer hash mismatch");
      attempted=true;
      var startup=new Startup(); startup.cb=(uint)Marshal.SizeOf(typeof(Startup)); ProcessInfo info;
      var args=new StringBuilder(path.Length+32); args.Append('"').Append(path).Append('"').Append(" /S --updated --force-run");
      // Detached process, new group, NO inherited handles (including stdin/stdout pipes).
      if(CreateProcess(path,args,IntPtr.Zero,IntPtr.Zero,false,0x208,IntPtr.Zero,Path.GetDirectoryName(path),ref startup,out info)) {
       CloseHandle(info.thread); CloseHandle(info.process); return Started((int)info.pid);
      }
      int error=Marshal.GetLastWin32Error();
      if(error!=740) throw new Win32Exception(error);
      var shell=new Shell(); shell.cb=(uint)Marshal.SizeOf(typeof(Shell));
      // NOCLOSEPROCESS | NOASYNC | FLAG_NO_UI | UNICODE. In particular NOASYNC
      // prevents a queued shell request from outliving our protective handles.
      shell.mask=0x4540; shell.verb="runas"; shell.file=path; shell.args="/S --updated --force-run";
      shell.directory=Path.GetDirectoryName(path); shell.show=1;
      if(!ShellExecuteEx(ref shell)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if(shell.process==IntPtr.Zero) return Unknown();
      try { return Started((int)GetProcessId(shell.process)); } finally { CloseHandle(shell.process); }
     }
    }
   } catch(Win32Exception error) { return new Dictionary<string,object>{{"started",false},{"cancelled",error.NativeErrorCode==1223}}; }
   catch { return attempted ? Unknown() : new Dictionary<string,object>{{"started",false},{"cancelled",false}}; }
  }
 }
}
`
