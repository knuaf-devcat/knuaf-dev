// Download a python-build-standalone "install_only" runtime into resources/python for the current platform
// (or PBS_TARGET=aarch64-apple-darwin | x86_64-apple-darwin | x86_64-pc-windows-msvc). Verifies SHA256 when
// PBS_SHA256 is given. Usage: node scripts/fetch-python.mjs [--release 20250918] [--version 3.12.11]
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]] : []).filter(Boolean))
const release = args.release ?? process.env.PBS_RELEASE ?? '20250918'
const version = args.version ?? process.env.PBS_VERSION ?? '3.12.11'
const target = process.env.PBS_TARGET ?? (process.platform === 'darwin' ? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin') : 'x86_64-pc-windows-msvc')
const ext = target.includes('windows') ? 'tar.gz' : 'tar.gz'
const name = `cpython-${version}+${release}-${target}-install_only.${ext}`
const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${release}/${name}`
const app = resolve(import.meta.dirname, '..')
const out = resolve(app, 'resources', 'python')
const tmp = resolve(app, 'resources', name)
mkdirSync(resolve(app, 'resources'), { recursive: true })
console.log('downloading', url)
const res = await fetch(url)
if (!res.ok) { console.error('download failed', res.status); process.exit(1) }
await pipeline(res.body, createWriteStream(tmp))
if (process.env.PBS_SHA256) {
  const sum = spawnSync('shasum', ['-a', '256', tmp], { encoding: 'utf-8' }).stdout.split(' ')[0]
  if (sum !== process.env.PBS_SHA256) { console.error('sha256 mismatch', sum); process.exit(1) }
}
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const r = spawnSync('tar', ['-xzf', tmp, '-C', out, '--strip-components=1'], { stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status ?? 1)
rmSync(tmp)
console.log('python runtime →', out, existsSync(resolve(out, 'bin', 'python3')) ? '(bin/python3)' : existsSync(resolve(out, 'python.exe')) ? '(python.exe)' : '(check layout)')
