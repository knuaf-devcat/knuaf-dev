/**
 * 앱 전용 Python 런타임 — 다운로드·검증·게시.
 *
 * 설계 정본: `.track-python-oneclick/DESIGN.md` D1~D5 + §6 PY-D1-01 + §7 PY-D1-01.
 * 핵심 계약:
 * - 내려받는 바이트의 해시는 `app/python-runtime.json`에 **소스로 고정**되어 있다.
 *   실행 시점에 같은 서버의 SHA256SUMS를 믿지 않는다.
 * - 새 설치는 **항상 새 폴더**에 풀고, smoke 확인을 통과한 뒤에만 도장
 *   (`.knuaf-runtime.json`)을 같은 폴더 안에서 rename 으로 게시한다.
 * - 도장 있는 폴더는 앱이 자동으로 지우지 않는다(닫힌 프로젝트 venv가 참조할 수 있다).
 *   정리는 도장 없는 폴더와 남은 임시 다운로드 파일만.
 * - `KNUAF_RUNTIME_SPEC`·`KNUAF_RUNTIME_BASE_URL`은 **개발 빌드에서만** 읽는다.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { app, net } from 'electron'
import type { RuntimeStatus } from '../shared/types'

export interface RuntimeTarget {
  sha256: string
  size?: number
}

export interface RuntimeSpec {
  release: string
  version: string
  targets: Record<string, RuntimeTarget>
}

export interface RuntimeProgress {
  phase: string
  received?: number
  total?: number
}

export type RuntimeEvent = (event: RuntimeProgress) => void

export type RuntimeFailure = { code: string; message: string }

const STAMP = '.knuaf-runtime.json'
const HASH_RE = /^[0-9a-f]{64}$/
/** 도장 폴더 이름의 꼬리(설치 시각 ms) — 가장 최근 설치를 고르는 데 쓴다. */
const INSTALL_DIR_RE = /^cpython-.*-(\d+)$/
const MARKER = process.platform === 'win32' ? 'python.exe' : join('bin', 'python3')

export function targetTriple(): string | null {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'aarch64-apple-darwin' : process.arch === 'x64' ? 'x86_64-apple-darwin' : null
  if (process.platform === 'win32') return process.arch === 'x64' ? 'x86_64-pc-windows-msvc' : null
  return null
}

/**
 * 앱 루트 — `python.ts` 의 APP_ROOT 와 같은 자리(out/main → ../.., 패키지에서는 app.asar).
 * 그 파일을 여기서 import 하면 python.ts ↔ runtime.ts 순환이 되므로 같은 식을 둔다.
 * `app.getAppPath()` 는 이 저장소의 e2e 처럼 진입점을 out/main/index.js 로 직접 넘길 때
 * out/main 을 돌려준다 — 명세는 그 안에 없다.
 */
const APP_ROOT = resolve(__dirname, '..', '..')

function specPath(): string {
  if (!app.isPackaged && process.env.KNUAF_RUNTIME_SPEC) return process.env.KNUAF_RUNTIME_SPEC
  return join(APP_ROOT, 'python-runtime.json')
}

let cachedSpec: { path: string; mtimeMs: number; spec: RuntimeSpec } | null = null

export function loadRuntimeSpec(): RuntimeSpec {
  const path = specPath()
  const mtimeMs = statSync(path).mtimeMs
  if (cachedSpec && cachedSpec.path === path && cachedSpec.mtimeMs === mtimeMs) return cachedSpec.spec
  // 파싱 결과는 아래에서 필드마다 typeof 로 확인한다 — 모양이 어긋나면 여기서 닫는다.
  const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'))
  if (!raw || typeof raw !== 'object') throw { code: 'runtime_unsupported', message: '런타임 명세가 객체가 아님: ' + path } satisfies RuntimeFailure
  const release = 'release' in raw ? raw.release : undefined
  const version = 'version' in raw ? raw.version : undefined
  const targets = 'targets' in raw ? raw.targets : undefined
  if (typeof release !== 'string' || typeof version !== 'string' || !targets || typeof targets !== 'object') {
    throw { code: 'runtime_unsupported', message: '런타임 명세 형식이 맞지 않음: ' + path } satisfies RuntimeFailure
  }
  const checked: Record<string, RuntimeTarget> = {}
  for (const [name, value] of Object.entries(targets)) {
    if (!value || typeof value !== 'object') throw { code: 'runtime_unsupported', message: `런타임 명세 항목 오류: ${name}` } satisfies RuntimeFailure
    const sha256 = 'sha256' in value ? value.sha256 : undefined
    const size = 'size' in value ? value.size : undefined
    if (typeof sha256 !== 'string' || !HASH_RE.test(sha256)) throw { code: 'runtime_unsupported', message: `런타임 명세 해시 오류: ${name}` } satisfies RuntimeFailure
    if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size) || size <= 0)) {
      throw { code: 'runtime_unsupported', message: `런타임 명세 크기 오류: ${name}` } satisfies RuntimeFailure
    }
    checked[name] = { sha256, ...(typeof size === 'number' ? { size } : {}) }
  }
  const spec: RuntimeSpec = { release, version, targets: checked }
  cachedSpec = { path, mtimeMs, spec }
  return spec
}

/** macOS는 userData, Windows는 LOCALAPPDATA(로밍 프로필에 100MB를 두지 않는다). */
export function runtimeRoot(): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, app.getName(), 'runtime')
  return join(app.getPath('userData'), 'runtime')
}

interface Stamp { version: string; release: string; target: string; sha256: string }

function readStamp(dir: string): Stamp | null {
  try {
    // 디스크에서 온 JSON — 네 필드의 typeof 를 모두 확인한 뒤에만 통과시킨다.
    const parsed: unknown = JSON.parse(readFileSync(join(dir, STAMP), 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return null
    const { version, release, target, sha256 } = parsed as Record<string, unknown>
    if (typeof version !== 'string' || typeof release !== 'string' || typeof target !== 'string' || typeof sha256 !== 'string') return null
    return { version, release, target, sha256 }
  } catch {
    return null
  }
}

/** 도장·marker가 현재 명세와 맞는 설치 중 가장 최근 것. smoke 확인은 하지 않는다(선택은 동기). */
function findInstall(spec: RuntimeSpec, target: string): string | null {
  const root = runtimeRoot()
  let names: string[]
  try { names = readdirSync(root) } catch { return null }
  let best: { dir: string; ms: number } | null = null
  for (const name of names) {
    const m = INSTALL_DIR_RE.exec(name)
    if (!m) continue
    const dir = join(root, name)
    const stamp = readStamp(dir)
    if (!stamp) continue
    const expected = spec.targets[target]
    if (!expected) continue
    if (stamp.version !== spec.version || stamp.release !== spec.release || stamp.target !== target || stamp.sha256 !== expected.sha256) continue
    if (!existsSync(join(dir, MARKER))) continue
    const ms = Number(m[1])
    if (!best || ms > best.ms) best = { dir, ms }
  }
  return best?.dir ?? null
}

/** 관리 런타임의 인터프리터. 도장·marker가 명세와 맞을 때만 쓴다. */
export function managedPython(): string | null {
  let spec: RuntimeSpec
  try { spec = loadRuntimeSpec() } catch { return null }
  const target = targetTriple()
  if (!target) return null
  const dir = findInstall(spec, target)
  return dir ? join(dir, MARKER) : null
}

export function runtimeStatus(): RuntimeStatus {
  let spec: RuntimeSpec
  try { spec = loadRuntimeSpec() } catch {
    return { supported: false, target: null, installed: false, sizeBytes: null }
  }
  const target = targetTriple()
  if (!target || !spec.targets[target]) return { supported: false, target, installed: false, sizeBytes: null }
  return { supported: true, target, installed: findInstall(spec, target) !== null, sizeBytes: spec.targets[target].size ?? null }
}

/**
 * 앱 시작·설치 성공 뒤 정리. 도장 없는 설치 폴더와 임시 다운로드만 지운다.
 * 게시된(도장 있는) 폴더는 어떤 경우에도 지우지 않는다 — §7 PY-D1-01.
 */
export function cleanupRuntime(): void {
  const root = runtimeRoot()
  let names: string[]
  try { names = readdirSync(root) } catch { return }
  for (const name of names) {
    const incomplete = INSTALL_DIR_RE.test(name) && !readStamp(join(root, name))
    if (!incomplete && !name.startsWith('.download-')) continue
    try { rmSync(join(root, name), { recursive: true, force: true }) } catch { /* 다음 시작에 다시 시도 */ }
  }
}

function tarPath(): string | null {
  if (process.platform === 'win32') {
    const p = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    return existsSync(p) ? p : null
  }
  return existsSync('/usr/bin/tar') ? '/usr/bin/tar' : null
}

function extract(archive: string, dest: string): Promise<void> {
  const tar = tarPath()
  if (!tar) return Promise.reject({ code: 'runtime_tar_missing', message: 'tar 실행 파일을 찾지 못함' } satisfies RuntimeFailure)
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const p = spawn(tar, ['-xzf', archive, '-C', dest, '--strip-components=1'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  p.stderr.on('data', (c) => { stderr += String(c) })
  p.on('error', (e) => reject({ code: 'runtime_extract_failed', message: String(e) } satisfies RuntimeFailure))
  p.on('exit', (code) => code === 0
    ? resolve()
    : reject({ code: 'runtime_extract_failed', message: `tar exit ${code}: ${stderr.slice(-400)}` } satisfies RuntimeFailure))
  return promise
}

const SMOKE = [
  'import json, platform, ssl, sqlite3, venv',
  'print(json.dumps({"version": platform.python_version()}))'
].join('\n')

/** `-I -c`로 버전을 정확히 비교하고 ssl·venv·sqlite3 import까지 확인한다. */
function smoke(python: string, version: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const p = spawn(python, ['-I', '-c', SMOKE], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  let err = ''
  const timer = setTimeout(() => { try { p.kill() } catch { /* ignore */ } }, 30_000)
  p.stdout.on('data', (c) => { out += String(c) })
  p.stderr.on('data', (c) => { err += String(c) })
  p.on('error', (e) => { clearTimeout(timer); reject({ code: 'runtime_extract_failed', message: `Python 확인 실행 실패: ${e}` } satisfies RuntimeFailure) })
  p.on('exit', (code) => {
    clearTimeout(timer)
    if (code !== 0) { reject({ code: 'runtime_extract_failed', message: `Python 확인 실패 (exit ${code}): ${err.slice(-400)}` } satisfies RuntimeFailure); return }
    let got = ''
    try {
      const parsed: unknown = JSON.parse(out.trim().split('\n').at(-1) ?? '{}')
      if (parsed && typeof parsed === 'object' && 'version' in parsed && typeof parsed.version === 'string') got = parsed.version
    } catch { got = '' }
    if (got !== version) { reject({ code: 'runtime_extract_failed', message: `Python 버전 불일치: 기대 ${version}, 실제 ${got || '알 수 없음'}` } satisfies RuntimeFailure); return }
    resolve()
  })
  return promise
}

let installing: Promise<string> | null = null
let controller: AbortController | null = null

/** 진행 중 설치 취소. 다음 설치 요청은 새로 시작한다. */
export function cancelRuntimeInstall(): boolean {
  if (!controller) return false
  controller.abort()
  return true
}

function asFailure(error: unknown): RuntimeFailure {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && 'message' in error) {
    return { code: error.code, message: String(error.message) }
  }
  return { code: 'runtime_download_failed', message: error instanceof Error ? error.message : String(error) }
}

async function download(url: string, dest: string, expected: RuntimeTarget, onEvent: RuntimeEvent, signal: AbortSignal): Promise<void> {
  const res = await net.fetch(url, { signal })
  if (!res.ok) throw { code: 'runtime_download_failed', message: `내려받기 실패 ${res.status} ${res.statusText}` } satisfies RuntimeFailure
  if (!res.body) throw { code: 'runtime_download_failed', message: '응답 본문이 비어 있음' } satisfies RuntimeFailure
  const header = Number(res.headers.get('content-length') ?? 0)
  const total = expected.size ?? (Number.isFinite(header) ? header : 0)
  const hash = createHash('sha256')
  let received = 0
  const out = createWriteStream(dest)
  const opened = Promise.withResolvers<void>()
  out.once('open', () => opened.resolve())
  out.once('error', (e) => opened.reject(e))
  try {
    await opened.promise
    const reader = res.body.getReader()
    for (;;) {
      if (signal.aborted) throw { code: 'runtime_cancelled', message: '사용자가 취소함' } satisfies RuntimeFailure
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      received += value.byteLength
      if (!out.write(value)) {
        const drained = Promise.withResolvers<void>()
        out.once('drain', () => drained.resolve())
        await drained.promise
      }
      onEvent({ phase: '내려받는 중', received, total })
    }
    const closed = Promise.withResolvers<void>()
    out.end(() => closed.resolve())
    out.once('error', (e) => closed.reject(e))
    await closed.promise
  } catch (error) {
    out.destroy()
    if (signal.aborted) throw { code: 'runtime_cancelled', message: '사용자가 취소함' } satisfies RuntimeFailure
    throw asFailure(error)
  }
  if (expected.size !== undefined && received !== expected.size) {
    throw { code: 'runtime_hash_mismatch', message: `크기 불일치: 기대 ${expected.size}바이트, 실제 ${received}바이트` } satisfies RuntimeFailure
  }
  const digest = hash.digest('hex')
  if (digest !== expected.sha256) {
    throw { code: 'runtime_hash_mismatch', message: `sha256 불일치: 기대 ${expected.sha256}, 실제 ${digest}` } satisfies RuntimeFailure
  }
}

async function install(onEvent: RuntimeEvent): Promise<string> {
  const spec = loadRuntimeSpec()
  const target = targetTriple()
  if (!target || !spec.targets[target]) throw { code: 'runtime_unsupported', message: `지원하지 않는 플랫폼: ${process.platform}/${process.arch}` } satisfies RuntimeFailure
  const existing = findInstall(spec, target)
  if (existing) {
    try {
      onEvent({ phase: '확인 중' })
      await smoke(join(existing, MARKER), spec.version)
      return existing
    } catch { /* 도장은 있으나 파일이 깨짐 — 새 폴더로 다시 설치한다 */ }
  }

  const root = runtimeRoot()
  mkdirSync(root, { recursive: true })
  const ms = Date.now()
  const dir = join(root, `cpython-${spec.version}+${spec.release}-${target}-${ms}`)
  const archive = join(root, `.download-${ms}.tar.gz`)
  const abort = new AbortController()
  controller = abort
  try {
    onEvent({ phase: '내려받는 중', received: 0, total: spec.targets[target].size ?? 0 })
    const base = !app.isPackaged && process.env.KNUAF_RUNTIME_BASE_URL
      ? process.env.KNUAF_RUNTIME_BASE_URL.replace(/\/+$/, '')
      : `https://github.com/astral-sh/python-build-standalone/releases/download/${spec.release}`
    const name = `cpython-${spec.version}+${spec.release}-${target}-install_only.tar.gz`
    await download(`${base}/${name}`, archive, spec.targets[target], onEvent, abort.signal)
    onEvent({ phase: '푸는 중' })
    mkdirSync(dir, { recursive: true })
    await extract(archive, dir)
    onEvent({ phase: '확인 중' })
    await smoke(join(dir, MARKER), spec.version)
    // 게시 = 도장. 같은 폴더 안 단일 rename(원자). 도장 없는 폴더는 미완성이다.
    const stamp: Stamp = { version: spec.version, release: spec.release, target, sha256: spec.targets[target].sha256 }
    const tmp = join(dir, `${STAMP}.tmp`)
    writeFileSync(tmp, JSON.stringify(stamp, null, 2), 'utf-8')
    renameSync(tmp, join(dir, STAMP))
    return dir
  } catch (error) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 다음 시작 정리 */ }
    throw asFailure(error)
  } finally {
    try { rmSync(archive, { force: true }) } catch { /* 남으면 다음 시작 정리 */ }
    controller = null
  }
}

/**
 * 설치(프로세스 전역 1건). 유효 설치가 이미 있으면 새로 받지 않고 그 폴더를 돌려준다.
 * 진행 중 재요청은 같은 약속에 합류한다.
 */
export function installRuntime(onEvent: RuntimeEvent): Promise<string> {
  if (installing) return installing
  installing = install(onEvent).finally(() => { installing = null })
  return installing
}
