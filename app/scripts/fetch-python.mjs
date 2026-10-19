// Download a python-build-standalone "install_only" runtime into resources/python for the current platform
// (or PBS_TARGET=aarch64-apple-darwin | x86_64-apple-darwin | x86_64-pc-windows-msvc).
// Usage: node scripts/fetch-python.mjs [--release R] [--version V] [--force]
//
// Integrity: release·version·sha256 의 정본은 `app/python-runtime.json` 이다 — 앱 안의
// 클릭 설치(src/main/runtime.ts)가 **같은 바이트**를 받는다(D1). 기본 실행은 그 명세의
// 고정 해시로 검증하며, 네트워크의 SHA256SUMS 를 믿지 않는다. 빌드 작업자가 다른 빌드를
// 시험할 때만 PBS_RELEASE/PBS_VERSION/PBS_SHA256 으로 덮어쓴다 — 그 경우 "앱 설치와 같은
// 바이트"라는 설명은 성립하지 않는다(명세는 그대로이므로 앱은 명세의 해시를 계속 요구한다).
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const force = argv.includes('--force') || process.env.PBS_FORCE === '1'
const app = resolve(import.meta.dirname, '..')
const spec = JSON.parse(readFileSync(resolve(app, 'python-runtime.json'), 'utf-8'))
const release = flag('release') ?? process.env.PBS_RELEASE ?? spec.release
const version = flag('version') ?? process.env.PBS_VERSION ?? spec.version
const target =
  process.env.PBS_TARGET ??
  (process.platform === 'darwin'
    ? process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin'
    : 'x86_64-pc-windows-msvc')
const pinned = spec.targets?.[target]
const overridden = Boolean(process.env.PBS_RELEASE || process.env.PBS_VERSION || flag('release') || flag('version'))
if (!pinned && !process.env.PBS_SHA256) {
  console.error(`python-runtime.json has no target ${target}; set PBS_SHA256 to pin the digest`)
  process.exit(1)
}

const out = resolve(app, 'resources', 'python')
// 마커는 **대상** 플랫폼을 따른다 — `PBS_TARGET` 으로 다른 OS 런타임을 받을 수 있으므로
// 호스트(process.platform)를 보면 윈도우 런타임을 받고도 `bin/python3` 을 찾다 실패한다.
const marker = target.includes('windows') ? resolve(out, 'python.exe') : resolve(out, 'bin', 'python3')

if (!force && existsSync(marker)) {
  console.log('python runtime already present →', out, '(use --force to re-download)')
  process.exit(0)
}

const name = `cpython-${version}+${release}-${target}-install_only.tar.gz`
const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${release}/${name}`
const tmp = resolve(app, 'resources', name)
mkdirSync(resolve(app, 'resources'), { recursive: true })

console.log('downloading', url)
const res = await fetch(url)
if (!res.ok) {
  console.error(`download failed ${res.status} ${res.statusText} — is release ${release} still published?`)
  process.exit(1)
}
await pipeline(res.body, createWriteStream(tmp))

const digest = await new Promise((ok, fail) => {
  const h = createHash('sha256')
  createReadStream(tmp).on('error', fail).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex')))
})

let expected = process.env.PBS_SHA256
let origin = 'PBS_SHA256'
if (!expected) {
  if (overridden) {
    rmSync(tmp, { force: true })
    console.error('release/version overridden without PBS_SHA256 — the pinned spec hash does not apply; pass PBS_SHA256')
    process.exit(1)
  }
  expected = pinned.sha256
  origin = `python-runtime.json (${target})`
}
if (digest !== expected) {
  rmSync(tmp, { force: true })
  console.error(`sha256 mismatch against ${origin}\n  expected ${expected}\n  got      ${digest}`)
  process.exit(1)
}
if (pinned?.size !== undefined && !overridden) {
  const { size } = statSync(tmp)
  if (size !== pinned.size) {
    rmSync(tmp, { force: true })
    console.error(`size mismatch against python-runtime.json\n  expected ${pinned.size}\n  got      ${size}`)
    process.exit(1)
  }
}
console.log('sha256 verified against', origin)

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const r = spawnSync('tar', ['-xzf', tmp, '-C', out, '--strip-components=1'], { stdio: 'inherit' })
rmSync(tmp, { force: true })
if (r.status !== 0) process.exit(r.status ?? 1)
if (!existsSync(marker)) {
  console.error('extracted, but', marker, 'is missing — check the archive layout')
  process.exit(1)
}
console.log('python runtime →', out)
