// Shared by the store broker and installer. No path-based I/O is allowed before ancestor pins.
export const NATIVE_FILES = String.raw`
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
namespace KnuafUpdate {
 public sealed class Files : IDisposable {
  [StructLayout(LayoutKind.Sequential)] public struct Info {
   public uint attributes, cLow,cHigh,aLow,aHigh,wLow,wHigh,volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file,StringBuilder path,uint length,uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetLongPathName(string path,StringBuilder output,uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool MoveFileEx(string source,string target,uint flags);
  readonly Dictionary<string,SafeFileHandle> pins=new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
  readonly string owner=WindowsIdentity.GetCurrent().User.Value;
  public readonly string Root;
  static string Normalize(string path) {
   if(path.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase)) path=@"\\"+path.Substring(8);
   else if(path.StartsWith(@"\\?\",StringComparison.OrdinalIgnoreCase)) path=path.Substring(4);
   return Path.GetFullPath(path).TrimEnd('\\');
  }
  static string Long(string path) {
   var text=new StringBuilder(32768); uint n=GetLongPathName(path,text,32768);
   if(n==0 || n>=32768) throw new Win32Exception(Marshal.GetLastWin32Error());
   return Normalize(text.ToString());
  }
  void Check(SafeFileHandle handle,string path,bool directory,bool owned) {
   Info info; if(!GetFileInformationByHandle(handle,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
   if((info.attributes & 0x400)!=0 || ((info.attributes & 0x10)!=0)!=directory || (!directory && info.links!=1)) throw new IOException("Update path is a reparse point, wrong kind, or multiply linked");
   var text=new StringBuilder(32768); uint n=GetFinalPathNameByHandle(handle,text,32768,0);
   if(n==0 || n>=32768 || !String.Equals(Normalize(text.ToString()),Long(path),StringComparison.OrdinalIgnoreCase)) throw new IOException("Update path identity is ambiguous");
   if(owned) {
    string actual=directory ? Directory.GetAccessControl(path).GetOwner(typeof(SecurityIdentifier)).Value : File.GetAccessControl(path).GetOwner(typeof(SecurityIdentifier)).Value;
    if(actual!=owner) throw new IOException("Update path owner is not the current user");
   }
  }
  void Pin(string path,bool owned) {
   path=Path.GetFullPath(path); if(pins.ContainsKey(path)) return;
   // FILE_READ_ATTRIBUTES | READ_CONTROL, share READ/WRITE but NOT DELETE.
   // OPEN_REPARSE_POINT prevents traversal; BACKUP_SEMANTICS opens directories.
   var handle=CreateFile(path,0x20080,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
   if(handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
   try { Check(handle,path,true,owned); pins.Add(path,handle); } catch { handle.Dispose(); throw; }
  }
  void Chain(string path) {
   string parent=Path.GetDirectoryName(path);
   if(!String.IsNullOrEmpty(parent) && !String.Equals(path,parent,StringComparison.OrdinalIgnoreCase)) Chain(parent);
   Pin(path,false);
  }
  static bool DirectoryEntry(string path) {
   try { var attributes=File.GetAttributes(path); if((attributes & FileAttributes.ReparsePoint)!=0 || (attributes & FileAttributes.Directory)==0) throw new IOException("Update directory is a reparse point or wrong kind"); return true; }
   catch(FileNotFoundException) { return false; } catch(DirectoryNotFoundException) { return false; }
  }
  public Files(string userData,bool create) {
   try {
    userData=Path.GetFullPath(userData); Chain(userData); PinOwner(userData);
    Root=Path.Combine(userData,"app-update");
    if(!DirectoryEntry(Root) && create) Directory.CreateDirectory(Root);
    if(DirectoryEntry(Root)) { Pin(Root,true); Scan(Root); }
   } catch { Dispose(); throw; }
  }
  void PinOwner(string path) {
   if(Directory.GetAccessControl(path).GetOwner(typeof(SecurityIdentifier)).Value!=owner) throw new IOException("Update store owner is not the current user");
  }
  public string Target(string relative,bool create) {
   relative=relative.Replace('\\','/');
   if(relative!="pending.json" && !System.Text.RegularExpressions.Regex.IsMatch(relative,@"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)/(installer\.exe|manifest\.json)$")) throw new IOException("Invalid update store member");
   if(!DirectoryEntry(Root)) { if(!create) return Path.Combine(Root,relative.Replace('/',Path.DirectorySeparatorChar)); throw new IOException("Update store is missing"); }
   Pin(Root,true); Scan(Root);
   string result=Path.Combine(Root,relative.Replace('/',Path.DirectorySeparatorChar)), parent=Path.GetDirectoryName(result);
   if(parent!=Root) {
    if(!DirectoryEntry(parent) && create) Directory.CreateDirectory(parent);
    if(DirectoryEntry(parent)) { Pin(parent,true); Scan(parent); }
   }
   return result;
  }
  public FileStream Open(string path) {
   // GENERIC_READ, FILE_SHARE_READ only. Deny writes, unlink, and rename until disposal.
   var handle=CreateFile(path,0x80000000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
   if(handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
   try { Check(handle,path,false,true); return new FileStream(handle,FileAccess.Read,65536,false); } catch { handle.Dispose(); throw; }
  }
  public string DownloadPath;
  public void CheckDownload(FileStream file,string path) { Check(file.SafeFileHandle,path,false,true); }
  public void Scan(string directory) {
   foreach(string entry in Directory.GetFileSystemEntries(directory)) {
    if(entry==DownloadPath) continue; // This exact entry is held with FileShare.None by the broker.
    FileAttributes attributes=File.GetAttributes(entry);
    if((attributes & FileAttributes.ReparsePoint)!=0) throw new IOException("Update store contains a reparse point");
    if((attributes & FileAttributes.Directory)==0) using(var file=Open(entry)) {}
    else PinOwner(entry);
   }
  }
  public bool Verify(string path,long size,string sha) {
   if(!File.Exists(path)) return false;
   using(var file=Open(path)) return Matches(file,size,sha);
  }
  public static bool Matches(FileStream file,long size,string sha) {
   if(file.Length!=size) return false;
   file.Position=0; using(var hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant()==sha;
  }
  public void Remove(string path) {
   if(!File.Exists(path)) return;
   using(var file=Open(path)) {}
   // Delete only this directory entry, never traverse or recursively delete a directory.
   File.Delete(path);
  }
  public void Replace(string temporary,string target) {
   if(File.Exists(target)) using(var file=Open(target)) {}
   // Atomic rename of the entry, not a write through the destination (including a raced link).
   if(!MoveFileEx(temporary,target,9)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public void Write(string target,byte[] bytes) {
   string temporary=target+"."+Guid.NewGuid().ToString("N")+".tmp";
   try {
    using(var file=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) { file.Write(bytes,0,bytes.Length); file.Flush(true); }
    Replace(temporary,target);
   } finally { if(File.Exists(temporary)) Remove(temporary); }
  }
  public void Dispose() { foreach(var pin in pins.Values) pin.Dispose(); pins.Clear(); }
 }
}
`
