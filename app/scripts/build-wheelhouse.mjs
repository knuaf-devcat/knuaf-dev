// Download the runtime wheels (requirements-runtime.txt) for offline `gg_deps.py ensure --no-index --find-links`.
// Uses the bundled runtime if present, else the interpreter in PYTHON env / python3. Platform tags come from that interpreter.
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const app = resolve(import.meta.dirname, '..')
const req = resolve(app, '..', 'skills', 'knuaf-doc', 'scripts', 'requirements-runtime.txt')
const out = resolve(app, 'resources', 'wheelhouse')
const bundled = process.platform === 'win32' ? resolve(app, 'resources', 'python', 'python.exe') : resolve(app, 'resources', 'python', 'bin', 'python3')
const py = process.env.PYTHON ?? (existsSync(bundled) ? bundled : 'python3')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const r = spawnSync(py, ['-m', 'pip', 'download', '--only-binary=:all:', '--dest', out, '-r', req, 'pip', 'setuptools'], { stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status ?? 1)
console.log('wheelhouse →', out)
