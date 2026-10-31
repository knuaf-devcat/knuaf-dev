import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve, win32 } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { constants as osConstants } from 'node:os'
import { NATIVE_FILES, STORE_FAILURE_CODES } from './nativeFiles'
import { object, version } from './manifest'

interface Command { op: 'read' | 'write' | 'verify' | 'remove' | 'begin' | 'chunk' | 'commit' | 'cleanup'; path: string; data?: Buffer; size?: number; sha256?: string }
export interface StoreBackend { request(command: Command): Promise<unknown>; close(): Promise<void> }
export type OpenStore = (userData: string, create: boolean) => Promise<StoreBackend>
const member = (path: string): string => {
  if (path === 'pending.json') return path
  const parts = path.split('/'); version(parts[0])
  if (parts.length !== 2 || !['installer.exe', 'manifest.json'].includes(parts[1])) throw new Error('앱 설치 파일 보관 경로를 확인하지 못했어요.')
  return path
}
export class StoreSession {
  constructor(private backend: StoreBackend) {}
  async read(path: string): Promise<string | null> {
    const value = await this.backend.request({ op: 'read', path: member(path) })
    if (value === null) return null
    if (typeof value !== 'string') throw new Error('앱 설치 기록을 읽지 못했어요.')
    return Buffer.from(value, 'base64').toString('utf8')
  }
  async write(path: string, value: unknown): Promise<void> { await this.backend.request({ op: 'write', path: member(path), data: Buffer.from(JSON.stringify(value)) }) }
  async remove(path: string): Promise<void> { await this.backend.request({ op: 'remove', path: member(path) }) }
  async verify(v: string, size: number, sha256: string): Promise<boolean> { return await this.backend.request({ op: 'verify', path: member(`${v}/installer.exe`), size, sha256 }) === true }
  async cleanup(v: string): Promise<void> { await this.backend.request({ op: 'cleanup', path: member(`${v}/installer.exe`) }) }
  async download(v: string, size: number, sha256: string): Promise<Writable> {
    const path = member(`${v}/installer.exe`)
    await this.backend.request({ op: 'begin', path, size, sha256 })
    return new Writable({ write: (chunk: Buffer, _encoding, callback) => {
      const write = async (): Promise<void> => {
        for (let offset = 0; offset < chunk.length; offset += 64 * 1024) await this.backend.request({ op: 'chunk', path, data: chunk.subarray(offset, offset + 64 * 1024) })
      }
      write().then(() => callback(), callback)
    } })
  }
  async commit(v: string): Promise<void> { await this.backend.request({ op: 'commit', path: member(`${v}/installer.exe`) }) }
}
export async function withStore<T>(open: OpenStore, userData: string, create: boolean, action: (store: StoreSession) => Promise<T>): Promise<T> {
  const backend = await open(userData, create)
  try { return await action(new StoreSession(backend)) } finally { await backend.close() }
}

/** Non-Windows filesystem implementation (and real-filesystem security tests). Windows uses the pinned native broker below. */
export class LocalStore implements StoreBackend {
  private root: string
  private base: string
  private identity: Map<string, { dev: number; ino: number }> = new Map()
  private download: { fd: number; temporary: string; target: string; size: number; sha256: string; dev: number; ino: number } | null = null
  constructor(private userData: string, create: boolean) {
    this.base = realpathSync(userData); this.root = join(userData, 'app-update')
    this.directory(userData)
    if (!existsSync(this.root) && create) mkdirSync(this.root)
    if (existsSync(this.root)) { this.directory(this.root); this.scan(this.root) }
    else { try { lstatSync(this.root); throw new Error('앱 설치 파일 보관 경로를 확인하지 못했어요.') } catch (error) { if (!isMissing(error)) throw error } }
  }
  private directory(path: string): void {
    const st = lstatSync(path), expected = this.identity.get(path)
    if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()) || (expected && (expected.dev !== st.dev || expected.ino !== st.ino))) throw new Error('앱 설치 파일 보관 경로를 확인하지 못했어요.')
    if (realpathSync(path) !== resolve(this.base, path === this.userData ? '' : path.slice(this.userData.length + 1))) throw new Error('앱 설치 파일 보관 경로를 확인하지 못했어요.')
    this.identity.set(path, { dev: st.dev, ino: st.ino })
  }
  private checked(path: string): number {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (process.getuid && before.uid !== process.getuid())) throw new Error('앱 설치 파일 링크·소유권을 확인하지 못했어요.')
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const actual = fstatSync(fd)
    if (actual.dev !== before.dev || actual.ino !== before.ino || actual.nlink !== 1) { closeSync(fd); throw new Error('앱 설치 파일이 바뀌었어요.') }
    return fd
  }
  private scan(path: string): void {
    for (const name of readdirSync(path)) {
      const entry = join(path, name), st = lstatSync(entry)
      if (st.isSymbolicLink()) throw new Error('앱 설치 파일 보관 경로를 확인하지 못했어요.')
      if (st.isDirectory()) this.directory(entry)
      else { const fd = this.checked(entry); closeSync(fd) }
    }
  }
  private target(relative: string, create = false): string {
    member(relative); this.directory(this.userData)
    if (!existsSync(this.root)) return join(this.root, relative)
    this.directory(this.root); this.scan(this.root)
    const path = join(this.root, relative), parent = resolve(path, '..')
    if (parent !== resolve(this.root)) {
      if (!existsSync(parent) && create) mkdirSync(parent)
      if (existsSync(parent)) { this.directory(parent); this.scan(parent) }
      else { try { lstatSync(parent); throw new Error('앱 설치 파일 보관 경로를 확인하지 못했어요.') } catch (error) { if (!isMissing(error)) throw error } }
    }
    return path
  }
  private matches(fd: number, size: number, sha256: string): boolean {
    if (fstatSync(fd).size !== size) return false
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
    let offset = 0, count: number
    while ((count = readSync(fd, buffer, 0, buffer.length, offset))) { hash.update(buffer.subarray(0, count)); offset += count }
    return hash.digest('hex') === sha256
  }
  private remove(path: string): void { if (existsSync(path)) { const fd = this.checked(path); closeSync(fd); unlinkSync(path) } }
  async request(command: Command): Promise<unknown> {
    const path = command.op === 'chunk' ? join(this.root, member(command.path)) : this.target(command.path, ['write', 'begin'].includes(command.op))
    switch (command.op) {
      case 'read': {
        if (!existsSync(path)) return null
        const fd = this.checked(path)
        try { if (fstatSync(fd).size > 1024 * 1024) throw new Error('앱 설치 기록이 너무 커요.'); return readFileSync(fd).toString('base64') } finally { closeSync(fd) }
      }
      case 'write': {
        const temporary = path + '.' + randomUUID() + '.tmp', fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { writeFileSync(fd, command.data!); fsyncSync(fd) } finally { closeSync(fd) }
        try { this.target(command.path); if (existsSync(path)) { const old = this.checked(path); closeSync(old) }; renameSync(temporary, path) } finally { this.remove(temporary) }
        return null
      }
      case 'remove': this.remove(path); return null
      case 'verify': {
        if (!existsSync(path)) return false
        const fd = this.checked(path)
        try { return this.matches(fd, command.size!, command.sha256!) } finally { closeSync(fd) }
      }
      case 'begin': {
        if (this.download) throw new Error('이미 설치 파일을 내려받고 있어요.')
        const temporary = path + '.' + randomUUID() + '.download', fd = openSync(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600), st = fstatSync(fd)
        this.download = { fd, temporary, target: path, size: command.size!, sha256: command.sha256!, dev: st.dev, ino: st.ino }; return null
      }
      case 'chunk': {
        if (!this.download || this.download.target !== path) throw new Error('설치 파일 저장 세션이 없어요.')
        let offset = 0; while (offset < command.data!.length) offset += writeSync(this.download.fd, command.data!, offset)
        return null
      }
      case 'commit': {
        const download = this.download
        if (!download || download.target !== path) throw new Error('설치 파일 저장 세션이 없어요.')
        fsyncSync(download.fd)
        const st = lstatSync(download.temporary), actual = fstatSync(download.fd)
        if (st.dev !== actual.dev || st.ino !== actual.ino || actual.dev !== download.dev || actual.ino !== download.ino || actual.nlink !== 1) throw new Error('설치 파일이 바뀌었어요.')
        if (!this.matches(download.fd, download.size, download.sha256)) throw new Error('설치 파일 해시가 달라요.')
        closeSync(download.fd); this.download = null
        try { renameSync(download.temporary, path) } finally { this.remove(download.temporary) }
        return null
      }
      case 'cleanup':
        // No recursive removal. Unknown student files remain even inside a version directory.
        this.remove(path); this.remove(this.target(command.path.replace('installer.exe', 'manifest.json'))); return null
    }
  }
  async close(): Promise<void> {
    if (this.download) {
      const { fd, temporary } = this.download; this.download = null; closeSync(fd)
      this.directory(this.userData); this.directory(this.root); this.directory(resolve(temporary, '..')); this.remove(temporary)
    }
  }
}
function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' }

const STORE_NATIVE = String.raw`
namespace KnuafUpdate {
 public static class StoreWorker {
  public static Dictionary<string,object> Failure(Exception error,string stage) {
   while(error.InnerException!=null) error=error.InnerException;
   var native=error as Win32Exception;
   return new Dictionary<string,object>{{"ok",false},{"diagnostic",new Dictionary<string,object>{
    {"stage",stage},{"type",error.GetType().FullName},{"nativeCode",native==null ? error.Data["knuaf_store_win32"] : (object)native.NativeErrorCode},{"hresult",error.HResult},{"message",error.Message},{"failure",error.Data["knuaf_store_failure"]}
   }}};
  }
  public static void Run(string userData,bool create) {
   var json=new System.Web.Script.Serialization.JavaScriptSerializer(); json.MaxJsonLength=4*1024*1024;
   FileStream download=null; string temporary=null,target=null,activeRelative=null; long size=0; string sha=null;
   using(var files=new Files(userData,create)) {
    Console.WriteLine("{\"ok\":true}");
    try {
     string line; while((line=Console.ReadLine())!=null) {
      string operation="request";
      try {
       var command=json.Deserialize<Dictionary<string,object>>(line); string op=(string)command["op"], relative=(string)command["path"];
       operation=op;
       string path; object result=null;
       if(op=="chunk") {
        if(download==null) throw Files.Reject(StoreFailure.chunk_session_missing);
        if(relative!=activeRelative) throw Files.Reject(StoreFailure.chunk_member_mismatch);
        path=target;
       }
       else path=files.Target(relative,op=="begin" || op=="write");
       switch(op) {
        case "read": if(File.Exists(path)) using(var file=files.Open(path)) { if(file.Length>1024*1024) throw Files.Reject(StoreFailure.record_too_large); var bytes=new byte[(int)file.Length]; int offset=0,n; while(offset<bytes.Length && (n=file.Read(bytes,offset,bytes.Length-offset))>0) offset+=n; if(offset!=bytes.Length) throw Files.Reject(StoreFailure.record_short_read); result=Convert.ToBase64String(bytes); } break;
        case "write": files.Write(path,Convert.FromBase64String((string)command["data"])); break;
        case "remove": files.Remove(path); break;
        case "verify": result=files.Verify(path,Convert.ToInt64(command["size"]),(string)command["sha256"]); break;
        case "begin":
         if(download!=null) throw Files.Reject(StoreFailure.download_already_open);
         target=path; activeRelative=relative; size=Convert.ToInt64(command["size"]); sha=(string)command["sha256"]; temporary=path+"."+Guid.NewGuid().ToString("N")+".download";
         download=new FileStream(temporary,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.None); files.CheckDownload(download,temporary); files.DownloadPath=temporary; break;
        case "chunk":
         if(download==null || target!=path) throw Files.Reject(StoreFailure.chunk_target_mismatch);
         byte[] chunk=Convert.FromBase64String((string)command["data"]); if(download.Length+chunk.Length>size) throw Files.Reject(StoreFailure.download_too_large); download.Write(chunk,0,chunk.Length); break;
        case "commit":
         if(download==null || target!=path) throw Files.Reject(StoreFailure.commit_without_download);
         files.CheckDownload(download,temporary); download.Flush(true); if(!Files.Matches(download,size,sha)) throw Files.Reject(StoreFailure.download_hash_mismatch);
         download.Dispose(); download=null; files.DownloadPath=null; files.Replace(temporary,target); temporary=null; break;
        case "cleanup": files.Remove(path); files.Remove(files.Target(relative.Replace("installer.exe","manifest.json"),false)); break;
        default: throw Files.Reject(StoreFailure.unknown_operation);
       }
       Console.WriteLine(json.Serialize(new Dictionary<string,object>{{"ok",true},{"result",result}}));
      } catch(Exception error) { Console.WriteLine(json.Serialize(Failure(error,operation))); }
     }
    } finally { if(download!=null) download.Dispose(); files.DownloadPath=null; if(temporary!=null && File.Exists(temporary)) files.Remove(temporary); }
   }
  }
 }
}
`
const quote = (value: string): string => "'" + value.replaceAll("'", "''") + "'"
interface Reply { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
export interface StoreDiagnostic {
  reason: 'spawn' | 'stdin' | 'exit' | 'timeout' | 'protocol' | 'native'
  stage: string
  exitCode?: number | null
  signal?: string | null
  osCode?: string
  nativeType?: string
  nativeFailure?: string
  nativeCode?: number
  hresult?: string
  errno?: number
  compilerCodes?: string[]
}
/** Return the stored names, never the untrusted lookup string. */
function fixedNames<const T extends string>(names: readonly T[]): ReadonlyMap<string, T> {
  const result = new Map<string, T>()
  for (const name of names) result.set(name, name)
  return result
}
const stages = fixedNames(['initialize', 'close', 'read', 'write', 'verify', 'remove', 'begin', 'chunk', 'commit', 'cleanup'])
const reasons = fixedNames(['spawn', 'stdin', 'exit', 'timeout', 'protocol', 'native'])
const signals = fixedNames(Object.keys(osConstants.signals))
const osCodes = fixedNames(Object.keys(osConstants.errno))
const nativeFailures = fixedNames(STORE_FAILURE_CODES)
// Native file/ACL/stream operations, conversion/JSON, and Add-Type/Invoke-Expression.
// Full names remain stable diagnostic categories; anything unlisted is just "other".
const nativeTypes = fixedNames([
  'System.Exception',
  'System.UnauthorizedAccessException',
  'System.IO.IOException',
  'System.IO.FileNotFoundException',
  'System.IO.DirectoryNotFoundException',
  'System.IO.PathTooLongException',
  'System.IO.FileLoadException',
  'System.ArgumentException',
  'System.ArgumentNullException',
  'System.ArgumentOutOfRangeException',
  'System.InvalidOperationException',
  'System.NotSupportedException',
  'System.Security.SecurityException',
  'System.ComponentModel.Win32Exception',
  'System.TypeLoadException',
  'System.Reflection.ReflectionTypeLoadException',
  'System.MissingMethodException',
  'System.BadImageFormatException',
  'System.FormatException',
  'System.OverflowException',
  'System.Management.Automation.ParseException',
  'System.Management.Automation.RuntimeException'
])
const powershellCodes = fixedNames(['SOURCE_CODE_ERROR', 'COMPILER_ERRORS', 'TYPE_ALREADY_EXISTS', 'ASSEMBLY_LOAD_ERRORS'])
function compilerCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  const numeric = value.length === 6 ? /^(CS|PS)([0-9]{4})$/.exec(value) : null
  if (numeric) return `${numeric[1] === 'CS' ? 'CS' : 'PS'}${Number(numeric[2]).toString().padStart(4, '0')}`
  return powershellCodes.get(value)
}
function compilerCodes(text: string): string[] {
  const codes: string[] = []
  for (const match of text.slice(0, 16 * 1024).matchAll(/\b(?:(?:CS|PS)\d{4}|SOURCE_CODE_ERROR|COMPILER_ERRORS|TYPE_ALREADY_EXISTS|ASSEMBLY_LOAD_ERRORS)\b/g)) {
    const code = compilerCode(match[0])!
    if (!codes.includes(code)) codes.push(code)
    if (codes.length === 16) break
  }
  return codes
}
function nativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= -0x80000000 && value <= 0xffffffff
}
export class StoreBrokerError extends Error {
  readonly code: string
  readonly diagnostic: StoreDiagnostic
  constructor(input: StoreDiagnostic) {
    // Pick fields, never spread untrusted diagnostics or retain free text/cause.
    const diagnostic: StoreDiagnostic = {
      reason: reasons.get(input.reason) ?? 'protocol',
      stage: stages.get(input.stage) ?? 'unknown'
    }
    if (input.exitCode === null || nativeInteger(input.exitCode)) diagnostic.exitCode = input.exitCode
    const signal = typeof input.signal === 'string' ? signals.get(input.signal) : undefined
    const osCode = typeof input.osCode === 'string' ? osCodes.get(input.osCode) : undefined
    if (signal) diagnostic.signal = signal
    if (osCode) diagnostic.osCode = osCode
    if (nativeInteger(input.errno)) diagnostic.errno = input.errno
    if (input.nativeType !== undefined) diagnostic.nativeType = (typeof input.nativeType === 'string' ? nativeTypes.get(input.nativeType) : undefined) ?? 'other'
    if (input.nativeFailure !== undefined) diagnostic.nativeFailure = (typeof input.nativeFailure === 'string' ? nativeFailures.get(input.nativeFailure) : undefined) ?? 'other'
    if (nativeInteger(input.nativeCode)) diagnostic.nativeCode = input.nativeCode
    if (typeof input.hresult === 'string' && input.hresult.length === 10 && /^0x[0-9a-f]{8}$/.test(input.hresult)) diagnostic.hresult = `0x${Number.parseInt(input.hresult.slice(2), 16).toString(16).padStart(8, '0')}`
    if (Array.isArray(input.compilerCodes)) {
      const codes: string[] = []
      for (const value of input.compilerCodes) {
        const code = compilerCode(value)
        if (code && !codes.includes(code)) codes.push(code)
        if (codes.length === 16) break
      }
      if (codes.length) diagnostic.compilerCodes = codes
    }
    const context = [`stage=${diagnostic.stage}`, `reason=${diagnostic.reason}`]
    if (diagnostic.exitCode !== undefined) context.push(`exit=${diagnostic.exitCode}`)
    if (diagnostic.signal) context.push(`signal=${diagnostic.signal}`)
    if (diagnostic.osCode) context.push(`os=${diagnostic.osCode}`)
    if (diagnostic.errno !== undefined) context.push(`errno=${diagnostic.errno}`)
    if (diagnostic.nativeType) context.push(`native=${diagnostic.nativeType}`)
    if (diagnostic.nativeFailure) context.push(`failure=${diagnostic.nativeFailure}`)
    if (diagnostic.nativeCode !== undefined) context.push(`nativeCode=${diagnostic.nativeCode}`)
    if (diagnostic.hresult) context.push(`hresult=${diagnostic.hresult}`)
    if (diagnostic.compilerCodes) context.push(`compiler=${diagnostic.compilerCodes.join(',')}`)
    super(`앱 설치 파일 보관 경로·네이티브 핸들을 확인하지 못했어요. [${context.join('; ')}]`)
    this.name = 'StoreBrokerError'; this.code = `update_store_${diagnostic.reason}`; this.diagnostic = diagnostic
    this.stack = `${this.name}: ${this.message}`
  }
}
export async function connectStoreBroker(
  child: ChildProcessWithoutNullStreams, script: string,
  deadlines: { ready?: number; close?: number } = {}
): Promise<StoreBackend> {
  const lines = createInterface({ input: child.stdout }), ready = Promise.withResolvers<unknown>(), exited = Promise.withResolvers<void>()
  let pending: Reply | null = ready, failed: StoreBrokerError | null = null, stage = 'initialize', stderr = '', closing = false
  const fail = (reason: StoreDiagnostic['reason'], extra: Partial<StoreDiagnostic> = {}): void => {
    failed ??= new StoreBrokerError({ reason, stage, ...extra, compilerCodes: [...(extra.compilerCodes ?? []), ...compilerCodes(stderr)] })
    pending?.reject(failed); pending = null
  }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { if (stderr.length < 16 * 1024) stderr += chunk.slice(0, 16 * 1024 - stderr.length) })
  const ioError = (reason: 'spawn' | 'stdin', error: Error & { code?: string; errno?: number }): void => fail(reason, { osCode: error.code, errno: error.errno })
  lines.on('line', line => {
    let data: Record<string, unknown>
    try { data = object(JSON.parse(line)) } catch { fail('protocol'); return }
    if (data.ok !== true) {
      const native = data.diagnostic && typeof data.diagnostic === 'object' && !Array.isArray(data.diagnostic) ? data.diagnostic as Record<string, unknown> : {}
      fail('native', {
        nativeType: typeof native.type === 'string' ? native.type : 'other',
        ...(typeof native.failure === 'string' ? { nativeFailure: native.failure } : {}),
        ...(nativeInteger(native.nativeCode) ? { nativeCode: native.nativeCode } : {}),
        ...(nativeInteger(native.hresult) ? { hresult: `0x${(native.hresult >>> 0).toString(16).padStart(8, '0')}` } : {}),
        compilerCodes: [...compilerCodes(typeof native.message === 'string' ? native.message : ''), ...compilerCodes(typeof native.errorId === 'string' ? native.errorId : '')]
      })
      return
    }
    if (!pending) { fail('protocol'); return }
    const reply = pending; pending = null; reply.resolve(data.result)
  })
  child.once('error', error => ioError('spawn', error))
  child.stdin.on('error', error => ioError('stdin', error))
  child.once('close', (exitCode, signal) => {
    if (!closing || exitCode !== 0) fail('exit', { exitCode, signal })
    exited.resolve()
  })
  const timer = setTimeout(() => { fail('timeout'); child.kill() }, deadlines.ready ?? 15_000)
  child.stdin.write(Buffer.from(script, 'utf8').toString('base64') + '\n')
  try { await ready.promise } catch (error) {
    child.kill(); await exited.promise
    // stdout/stderr are independent pipes. Extract only codes arriving during cleanup.
    if (error instanceof StoreBrokerError) throw new StoreBrokerError({ ...error.diagnostic, compilerCodes: [...(error.diagnostic.compilerCodes ?? []), ...compilerCodes(stderr)] })
    throw error
  } finally { clearTimeout(timer) }
  return {
    async request(command) {
      if (failed || pending || closing) throw failed ?? new Error('앱 설치 파일 저장 요청이 겹쳤어요.')
      stage = command.op
      const reply = Promise.withResolvers<unknown>(); pending = reply
      // Bounded binary chunks; never put record contents or malformed stdout in diagnostics.
      child.stdin.write(JSON.stringify({ ...command, ...(command.data ? { data: command.data.toString('base64') } : {}) }) + '\n')
      return reply.promise
    },
    async close() {
      closing = true; stage = 'close'; child.stdin.end()
      const timer = setTimeout(() => { fail('timeout'); child.kill() }, deadlines.close ?? 5_000)
      try { await exited.promise; if (failed) throw failed } finally { clearTimeout(timer); lines.close() }
    }
  }
}
async function nativeStore(userData: string, create: boolean): Promise<StoreBackend> {
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; try { Add-Type -ReferencedAssemblies System.dll,System.Core.dll,System.Web.Extensions.dll -TypeDefinition @'\n${NATIVE_FILES}\n${STORE_NATIVE}\n'@; [KnuafUpdate.StoreWorker]::Run(${quote(userData)},$${create}) } catch {
$e=$_.Exception; while ($e.InnerException) {$e=$e.InnerException};
$native=if ($e -is [System.ComponentModel.Win32Exception]) {$e.NativeErrorCode} else {$e.Data['knuaf_store_win32']};
@{ok=$false;diagnostic=@{stage='initialize';type=$e.GetType().FullName;nativeCode=$native;hresult=$e.HResult;message=$e.Message;errorId=$_.FullyQualifiedErrorId;failure=$e.Data['knuaf_store_failure']}} | ConvertTo-Json -Depth 4 -Compress; exit 1
}`
  const exe = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const bootstrap = 'Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())))'
  const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', bootstrap], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  return connectStoreBroker(child, script)
}
export const openStore: OpenStore = async (userData, create) => process.platform === 'win32' ? nativeStore(userData, create) : new LocalStore(userData, create)
