// Toolhelp snapshots the complete process set, rather than asynchronously enumerating CIM rows.
export const NATIVE_PROCESSES = String.raw`
namespace KnuafUpdate {
 using System;
 using System.Text;
 using System.Collections.Generic;
 using System.ComponentModel;
 using System.Runtime.InteropServices;
 public static class ProcessSnapshot {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Entry {
   public uint size,usage,pid; public UIntPtr heap; public uint module,threads,parent; public int priority; public uint flags;
   [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string name;
  }
  [StructLayout(LayoutKind.Sequential)] struct Time { public uint low,high; public long Value { get { return ((long)high<<32)|low; } } }
  public sealed class Row { public int pid,parent; public string created,name,path; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32First(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32Next(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out Time creation,out Time exit,out Time kernel,out Time user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static List<Row> Read(int collector) {
   DateTime captured=DateTime.UtcNow;
   var snapshot=CreateToolhelp32Snapshot(2,0); if(snapshot==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
   var rows=new List<Row>();
   try {
    var entry=new Entry(); entry.size=(uint)Marshal.SizeOf(typeof(Entry));
    if(!Process32First(snapshot,ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
    do {
     if(entry.pid==0) continue;
     var row=new Row{pid=(int)entry.pid,parent=(int)entry.parent,name=entry.name,created="",path=null};
     var process=OpenProcess(0x1000,false,entry.pid);
     if(process!=IntPtr.Zero) try {
      Time created,exited,kernel,user;
      if(GetProcessTimes(process,out created,out exited,out kernel,out user)) {
       var birth=DateTime.FromFileTimeUtc(created.Value);
       if(birth>captured) throw new InvalidOperationException("PID reused while reading process snapshot");
       row.created=birth.ToString("o");
      }
      uint size=32768; var path=new StringBuilder((int)size);
      if(QueryFullProcessImageName(process,0,path,ref size)) row.path=global::UpdateNativePath.Expand(path.ToString());
     } finally { CloseHandle(process); }
     rows.Add(row);
    } while(Process32Next(snapshot,ref entry));
    if(Marshal.GetLastWin32Error()!=18) throw new Win32Exception(Marshal.GetLastWin32Error());
   } finally { CloseHandle(snapshot); }
   // The trusted collector (including any compiler/console children) is maintenance,
   // not a provider to be stopped. No unrelated/app child is excluded by executable name.
   var identities=new Dictionary<int,Row>(); foreach(var row in rows) identities[row.pid]=row;
   var maintenance=new HashSet<int>(); maintenance.Add(collector); bool changed=true;
   while(changed) {
    changed=false;
    foreach(var row in rows) {
     Row parent;
     if(maintenance.Contains(row.parent) && identities.TryGetValue(row.parent,out parent) &&
        row.created!="" && parent.created!="" && String.CompareOrdinal(parent.created,row.created)<=0 && maintenance.Add(row.pid)) changed=true;
    }
   }
   rows.RemoveAll(row=>maintenance.Contains(row.pid)); return rows;
  }
 }
}
`
