/**
 * 시험용 앱 전용 런타임 — 네트워크 없이 설치 전 경로를 돌린다(D10).
 *
 * 가짜 tar.gz 안의 `bin/python3` 는 **실제 `.venv-dev` Python 을 exec 하는 셸 스크립트**다.
 * 그래서 smoke 확인(버전·ssl·venv·sqlite3)과 사이드카 실행이 진짜 파이썬으로 돈다.
 * 명세(`KNUAF_RUNTIME_SPEC`)의 version 은 그 파이썬의 실제 버전을 시험 시점에 적는다(PY-D1-04).
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { python } from '../helpers'
import { scratch } from './fake-codex'

export const TARGET = process.platform === 'darwin'
  ? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
  : 'x86_64-pc-windows-msvc'
const RELEASE = '20990101'

export interface FakeRuntime {
  dir: string
  specPath: string
  baseUrl: string
  archiveName: string
  version: string
  close: () => Promise<void>
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** `bin/python3` 가 실제 개발용 Python 을 exec 하는 tar.gz 를 만든다. */
function buildArchive(dir: string, version: string): string {
  const root = join(dir, 'stage')
  const bin = join(root, 'python', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'python3'), `#!/bin/sh\nexec ${JSON.stringify(python)} "$@"\n`, { mode: 0o755 })
  const name = `cpython-${version}+${RELEASE}-${TARGET}-install_only.tar.gz`
  const r = spawnSync('tar', ['-czf', join(dir, 'serve', name), '-C', root, 'python'], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
  return name
}

function serve(dir: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const file = join(dir, 'serve', decodeURIComponent((req.url ?? '/').replace(/^\/+/, '')))
    try {
      const body = readFileSync(file)
      res.writeHead(200, { 'content-length': String(body.byteLength) })
      res.end(body)
    } catch {
      res.writeHead(404).end()
    }
  })
  const { promise, resolve } = Promise.withResolvers<{ url: string; server: Server }>()
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    resolve({ url: `http://127.0.0.1:${port}`, server })
  })
  return promise
}

/**
 * 가짜 런타임 한 벌. `hash` 를 주면 명세에 그 값을 적는다(불일치 장면용).
 */
export async function fakeRuntime(opts: { hash?: string; size?: number } = {}): Promise<FakeRuntime> {
  const dir = scratch()
  mkdirSync(join(dir, 'serve'), { recursive: true })
  const version = spawnSync(python, ['-c', 'import platform; print(platform.python_version())'], { encoding: 'utf-8' }).stdout.trim()
  const archiveName = buildArchive(dir, version)
  const archive = join(dir, 'serve', archiveName)
  const { url, server } = await serve(dir)
  const specPath = join(dir, 'python-runtime.json')
  writeFileSync(specPath, JSON.stringify({
    release: RELEASE,
    version,
    targets: { [TARGET]: { sha256: opts.hash ?? sha256(archive), size: opts.size ?? readFileSync(archive).byteLength } }
  }), 'utf-8')
  return { dir, specPath, baseUrl: url, archiveName, version, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

/**
 * `python_too_old` 를 내는 가짜 `python3` — Finder 로 연 맥의 `/usr/bin/python3`(3.9) 자리다.
 * 사이드카는 첫 줄 JSON 오류를 읽고 `python_too_old` 로 실패한다.
 */
export function writeOldPython(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'python3')
  writeFileSync(file, '#!/bin/sh\nprintf \'%s\\n\' \'{"id": null, "error": {"code": "python_too_old", "message": "Python 3.10 이상 필요"}}\'\nexit 2\n', { mode: 0o755 })
  return file
}
