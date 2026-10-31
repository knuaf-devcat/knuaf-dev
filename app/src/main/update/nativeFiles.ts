// Shared by the store broker and installer. No path-based I/O is allowed before ancestor pins.
// One allowlist generates both the C# enum and the public diagnostic lookup.
export const STORE_FAILURE_CODES = [
  'pin_reparse', 'pin_kind_mismatch', 'file_link_count',
  'final_path_query_failed', 'final_path_buffer_limit', 'path_identity_mismatch',
  'pinned_owner_mismatch', 'pinned_owner_administrators',
  'directory_reparse', 'directory_kind_mismatch',
  'user_data_owner_mismatch', 'user_data_owner_administrators',
  'entry_owner_mismatch', 'entry_owner_administrators',
  'invalid_member', 'store_missing', 'scan_reparse',
  'chunk_session_missing', 'chunk_member_mismatch', 'record_too_large', 'record_short_read',
  'download_already_open', 'chunk_target_mismatch', 'download_too_large',
  'commit_without_download', 'download_hash_mismatch', 'unknown_operation',
  'token_identity_unavailable'
] as const
// SID values are canonical strings obtained from the process token and object ACL.
// The same equality expression drives C# and the non-Windows boundary contract model.
export const TOKEN_OWNER_MATCH = 'actual==tokenUser || actual==tokenOwner'
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
 public enum StoreFailure { ${STORE_FAILURE_CODES.join(',')} }
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
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out SafeFileHandle token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(SafeFileHandle token,int kind,IntPtr data,int length,out int needed);
  readonly Dictionary<string,SafeFileHandle> pins=new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
  readonly string tokenUser,tokenOwner;
  public readonly string Root;
  public static IOException Reject(StoreFailure failure,int? nativeCode=null) {
   var error=new IOException();
   error.Data["knuaf_store_failure"]=failure.ToString();
   if(nativeCode.HasValue) error.Data["knuaf_store_win32"]=nativeCode.Value;
   return error;
  }
  static string ReadTokenSid(SafeFileHandle token,int kind) {
   int length;
   bool unexpected=GetTokenInformation(token,kind,IntPtr.Zero,0,out length);
   int error=Marshal.GetLastWin32Error();
   if(unexpected || error!=122 || length<IntPtr.Size) throw Reject(StoreFailure.token_identity_unavailable,error);
   IntPtr data=Marshal.AllocHGlobal(length);
   try {
    int needed;
    if(!GetTokenInformation(token,kind,data,length,out needed)) throw Reject(StoreFailure.token_identity_unavailable,Marshal.GetLastWin32Error());
    if(needed<IntPtr.Size || needed>length) throw Reject(StoreFailure.token_identity_unavailable);
    // TOKEN_USER.User.Sid and TOKEN_OWNER.Owner are both the first pointer.
    IntPtr sid=Marshal.ReadIntPtr(data);
    if(sid==IntPtr.Zero) throw Reject(StoreFailure.token_identity_unavailable);
    try {
     string value=new SecurityIdentifier(sid).Value;
     if(String.IsNullOrEmpty(value)) throw Reject(StoreFailure.token_identity_unavailable);
     return value;
    } catch(ArgumentException) { throw Reject(StoreFailure.token_identity_unavailable); }
   } finally { Marshal.FreeHGlobal(data); }
  }
  static void ReadProcessOwners(out string user,out string owner) {
   SafeFileHandle token;
   // Open the process token explicitly: never substitute a thread impersonation token.
   if(!OpenProcessToken(GetCurrentProcess(),0x0008,out token)) {
    int error=Marshal.GetLastWin32Error();
    if(token!=null) token.Dispose();
    throw Reject(StoreFailure.token_identity_unavailable,error);
   }
   using(token) {
    if(token==null || token.IsInvalid) throw Reject(StoreFailure.token_identity_unavailable);
    user=ReadTokenSid(token,1); // TokenUser
    owner=ReadTokenSid(token,4); // TokenOwner; failure never falls back to TokenUser
   }
  }
  void CheckOwner(string actual,StoreFailure mismatch,StoreFailure administrators) {
   if(!(${TOKEN_OWNER_MATCH})) throw Reject(actual=="S-1-5-32-544" ? administrators : mismatch);
  }
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
   if((info.attributes & 0x400)!=0) throw Reject(StoreFailure.pin_reparse);
   if(((info.attributes & 0x10)!=0)!=directory) throw Reject(StoreFailure.pin_kind_mismatch);
   if(!directory && info.links!=1) throw Reject(StoreFailure.file_link_count);
   var text=new StringBuilder(32768); uint n=GetFinalPathNameByHandle(handle,text,32768,0);
   if(n==0) throw Reject(StoreFailure.final_path_query_failed,Marshal.GetLastWin32Error());
   if(n>=32768) throw Reject(StoreFailure.final_path_buffer_limit);
   if(!String.Equals(Normalize(text.ToString()),Long(path),StringComparison.OrdinalIgnoreCase)) throw Reject(StoreFailure.path_identity_mismatch);
   if(owned) {
    string actual=directory ? Directory.GetAccessControl(path).GetOwner(typeof(SecurityIdentifier)).Value : File.GetAccessControl(path).GetOwner(typeof(SecurityIdentifier)).Value;
    CheckOwner(actual,StoreFailure.pinned_owner_mismatch,StoreFailure.pinned_owner_administrators);
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
   try {
    var attributes=File.GetAttributes(path);
    if((attributes & FileAttributes.ReparsePoint)!=0) throw Reject(StoreFailure.directory_reparse);
    if((attributes & FileAttributes.Directory)==0) throw Reject(StoreFailure.directory_kind_mismatch);
    return true;
   }
   catch(FileNotFoundException) { return false; } catch(DirectoryNotFoundException) { return false; }
  }
  public Files(string userData,bool create) {
   try {
    string userSid,ownerSid; ReadProcessOwners(out userSid,out ownerSid);
    tokenUser=userSid; tokenOwner=ownerSid;
    userData=Path.GetFullPath(userData); Chain(userData); PinOwner(userData,StoreFailure.user_data_owner_mismatch,StoreFailure.user_data_owner_administrators);
    Root=Path.Combine(userData,"app-update");
    if(!DirectoryEntry(Root) && create) Directory.CreateDirectory(Root);
    if(DirectoryEntry(Root)) { Pin(Root,true); Scan(Root); }
   } catch { Dispose(); throw; }
  }
  void PinOwner(string path,StoreFailure mismatch,StoreFailure administrators) {
   CheckOwner(Directory.GetAccessControl(path).GetOwner(typeof(SecurityIdentifier)).Value,mismatch,administrators);
  }
  public string Target(string relative,bool create) {
   relative=relative.Replace('\\','/');
   if(relative!="pending.json" && !System.Text.RegularExpressions.Regex.IsMatch(relative,@"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)/(installer\.exe|manifest\.json)$")) throw Reject(StoreFailure.invalid_member);
   if(!DirectoryEntry(Root)) { if(!create) return Path.Combine(Root,relative.Replace('/',Path.DirectorySeparatorChar)); throw Reject(StoreFailure.store_missing); }
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
    if((attributes & FileAttributes.ReparsePoint)!=0) throw Reject(StoreFailure.scan_reparse);
    if((attributes & FileAttributes.Directory)==0) using(var file=Open(entry)) {}
    else PinOwner(entry,StoreFailure.entry_owner_mismatch,StoreFailure.entry_owner_administrators);
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
