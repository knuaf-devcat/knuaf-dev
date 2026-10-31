import { execFile } from 'node:child_process'
import { lstatSync, readdirSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { hash, object, version } from './manifest'
import { NATIVE_FILES } from './nativeFiles'
import { NATIVE_INSTALLER, type InstallerLaunch } from './nativeInstaller'
import { OwnedProcessWatch, resourcesBusy, type ProcessInfo, type ProcessSnapshot } from './processes'
import { NATIVE_PROCESSES } from './nativeProcesses'

export type PowerShell = (script: string, timeout: number, launch?: InstallerLaunch) => Promise<string>
const literal = (s: string): string => "'" + s.replaceAll("'", "''") + "'"
export const runPowerShell: PowerShell = async (script, timeout) => {
  if (process.platform !== 'win32') throw new Error('Windows에서만 실행할 수 있어요.')
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const exe = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; ' + script
  const bootstrap = 'Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))'
  const child = execFile(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', bootstrap], { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
    if (error) { reject(Object.assign(new Error('Windows 실행 결과를 확인하지 못했어요.'), { code: 'installer_unknown', cause: error })); return }
    resolve(stdout.replace(/^\uFEFF/, '').trim())
  })
  child.stdin?.end(Buffer.from(script, 'utf8').toString('base64'))
  return promise
}
const LONG_PATH = `Add-Type -ReferencedAssemblies System.dll,System.Core.dll -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class UpdateNativePath {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern uint GetLongPathName(string input, StringBuilder output, uint size);
 public static string Expand(string input) {
  if (String.IsNullOrEmpty(input)) return null;
  var output = new StringBuilder(32768);
  var count = GetLongPathName(input, output, 32768);
  return count > 0 && count < 32768 ? output.ToString() : null;
 }
}
${NATIVE_PROCESSES}
'@;`
export interface Inventory { resources: string; appExecutable: string; processes: ProcessInfo[] }
export class WindowsUpdateRuntime {
  constructor(private resources: string, private appExecutable: string, private appPid = process.pid, private shell: PowerShell = runPowerShell) {}
  async inventory(): Promise<Inventory> {
    const text = await this.shell(`$ErrorActionPreference='Stop'; ${LONG_PATH}
$r=[UpdateNativePath]::Expand(${literal(this.resources)}); if (!$r) { throw 'resources path unavailable' };
$e=[UpdateNativePath]::Expand(${literal(this.appExecutable)}); if (!$e) { throw 'app path unavailable' };
$rows=@([KnuafUpdate.ProcessSnapshot]::Read($PID));
@{resources=$r;appExecutable=$e;processes=$rows} | ConvertTo-Json -Depth 5 -Compress`, 15_000)
    const data = object(JSON.parse(text))
    if (typeof data.resources !== 'string' || typeof data.appExecutable !== 'string' || !Array.isArray(data.processes)) throw new Error('프로세스 목록을 확인하지 못했어요.')
    const processes = data.processes.map(value => {
      const p = object(value)
      if (!Number.isSafeInteger(p.pid) || Number(p.pid) < 1 || !Number.isSafeInteger(p.parent) || Number(p.parent) < 0 || typeof p.created !== 'string' || typeof p.name !== 'string' || !(p.path === null || typeof p.path === 'string')) throw new Error('프로세스 목록이 온전하지 않아요.')
      return p as unknown as ProcessInfo
    })
    return { resources: data.resources, appExecutable: data.appExecutable, processes }
  }
  async captureOwned(): Promise<ProcessSnapshot> {
    const inventory = await this.inventory()
    return { processes: inventory.processes, appPid: this.appPid, appExecutable: inventory.appExecutable }
  }
  async confirmStopped(before: ProcessSnapshot, timeout = 6_000): Promise<void> {
    const end = Date.now() + timeout, watch = new OwnedProcessWatch(before)
    for (;;) {
      if (!watch.busy((await this.inventory()).processes)) return
      if (Date.now() >= end) throw new Error('대화 도우미 프로세스 종료를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.')
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, Math.min(100, Math.max(0, end - Date.now())))
      await promise
    }
  }
  async assertResourcesIdle(): Promise<void> {
    const names: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name), st = lstatSync(path)
        if (st.isSymbolicLink()) throw new Error('동봉 실행물의 실제 경로를 확인하지 못했어요.')
        if (st.isDirectory()) walk(path)
        else if (st.isFile() && /\.exe$/i.test(entry.name)) names.push(entry.name)
      }
    }
    walk(this.resources)
    const inventory = await this.inventory()
    if (resourcesBusy(inventory.processes, inventory.resources, names)) throw new Error('도우미 창을 닫은 뒤 다시 눌러 주세요.')
  }
  async startInstaller(request: InstallerLaunch): Promise<void> {
    version(request.version); hash(request.sha256)
    if (!Number.isSafeInteger(request.size) || request.size < 1) throw new Error('설치 파일 크기가 잘못됐어요.')
    const text = await this.shell(`$ErrorActionPreference='Stop'; Add-Type -ReferencedAssemblies System.dll,System.Core.dll -TypeDefinition @'
${NATIVE_FILES}
${NATIVE_INSTALLER}
'@; [KnuafUpdate.Installer]::Execute(${literal(request.userData)},${literal(request.path)},${literal(request.version)},${request.size},${literal(request.sha256)}) | ConvertTo-Json -Compress`, 0, request)
    const unknown = (): Error => Object.assign(new Error('설치 파일 시작 여부를 확인하지 못했어요. 설치 기록을 보관했어요.'), { code: 'installer_unknown' })
    let result: Record<string, unknown>
    try { result = object(JSON.parse(text)) } catch { throw unknown() }
    // Only an exact acknowledgement may erase pending or permit quit. Noise, partial
    // output and contradictory fields cannot prove the process did NOT start.
    const fields = Object.keys(result).sort().join(',')
    if (fields === 'pid,started' && result.started === true && Number.isSafeInteger(result.pid) && Number(result.pid) > 0) return
    if (fields === 'cancelled,started' && result.started === false && typeof result.cancelled === 'boolean') throw new Error(result.cancelled ? '관리자 확인을 취소했어요. 다시 시도할 수 있어요.' : '설치 파일을 시작하지 못했어요.')
    throw unknown()
  }
}
