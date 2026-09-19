// Download a python-build-standalone "install_only" runtime into resources/python for the current platform
// (or PBS_TARGET=aarch64-apple-darwin | x86_64-apple-darwin | x86_64-pc-windows-msvc).
// Usage: node scripts/fetch-python.mjs [--release 20250918] [--version 3.12.11] [--force]
//
// Integrity: the archive is always hashed. PBS_SHA256 pins an expected digest; otherwise the
// release's published .sha256 is fetched and compared, so a truncated or corrupted download
// fails loudly instead of shipping. This interpreter runs skill scripts over student theses,
// so an unverified download is not acceptable — the previous version only checked when
// PBS_SHA256 happened to be set.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const force = argv.includes('--force') || process.env.PBS_FORCE === '1'
const release = flag('release') ?? process.env.PBS_RELEASE ?? '20250918'
const version = flag('version') ?? process.env.PBS_VERSION ?? '3.12.11'
const target =
  process.env.PBS_TARGET ??
  (process.platform === 'darwin'
    ? process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin'
    : 'x86_64-pc-windows-msvc')

const app = resolve(import.meta.dirname, '..')
const out = resolve(app, 'resources', 'python')
const marker = process.platform === 'win32' ? resolve(out, 'python.exe') : resolve(out, 'bin', 'python3')

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
  const sums = await fetch(
    `https://github.com/astral-sh/python-build-standalone/releases/download/${release}/SHA256SUMS`
  )
  if (!sums.ok) {
    rmSync(tmp, { force: true })
    console.error(`no SHA256SUMS for release ${release}; set PBS_SHA256 to pin the digest`)
    process.exit(1)
  }
  const line = (await sums.text()).split('\n').find((l) => l.trim().endsWith(` ${name}`))
  if (!line) {
    rmSync(tmp, { force: true })
    console.error(`${name} is not listed in SHA256SUMS; set PBS_SHA256 to pin the digest`)
    process.exit(1)
  }
  expected = line.trim().split(/\s+/)[0]
  origin = 'published SHA256SUMS'
}
if (digest !== expected) {
  rmSync(tmp, { force: true })
  console.error(`sha256 mismatch against ${origin}\n  expected ${expected}\n  got      ${digest}`)
  process.exit(1)
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
