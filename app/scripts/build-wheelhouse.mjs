// Download the runtime wheels (requirements-runtime.txt) for offline `gg_deps.py ensure --no-index --find-links`.
// Uses the bundled runtime if present, else the interpreter in PYTHON env / python3. Platform tags come from that interpreter.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const app = resolve(import.meta.dirname, '..')
const req = resolve(app, '..', 'skills', 'knuaf-dev', 'scripts', 'requirements-runtime.txt')
const out = resolve(app, 'resources', 'wheelhouse')
const bundled = process.platform === 'win32' ? resolve(app, 'resources', 'python', 'python.exe') : resolve(app, 'resources', 'python', 'bin', 'python3')
const py = process.env.PYTHON ?? (existsSync(bundled) ? bundled : 'python3')

// Idempotent so dist:* can depend on it without re-downloading every build.
const force = process.argv.includes('--force') || process.env.WHEELHOUSE_FORCE === '1'
if (!force && existsSync(out) && readdirSync(out).some((f) => f.endsWith('.whl'))) {
  console.log('wheelhouse already present →', out, '(use --force to rebuild)')
  process.exit(0)
}

// Wheels carry the platform tag of THIS interpreter, so a macOS host cannot build a
// Windows wheelhouse. ipc.ts retries deps.ensure online when the offline install fails,
// but that silently turns the offline promise into a network requirement — so say it here.
if (process.env.PBS_TARGET && !process.env.PBS_TARGET.includes(process.platform === 'win32' ? 'windows' : 'darwin')) {
  console.warn('warning: PBS_TARGET is a different platform; these wheels will not match it')
}
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const r = spawnSync(py, ['-m', 'pip', 'download', '--only-binary=:all:', '--dest', out, '-r', req, 'pip', 'setuptools'], {
  stdio: 'inherit',
  // pip 은 -r 파일을 **로케일 인코딩**으로 읽는다. 파일은 ASCII 로 두는 것이 원칙이지만,
  // 앞으로 비ASCII 바이트가 들어와도 한국어 Windows(cp949)·서구 Windows(cp1252)에서
  // UnicodeDecodeError 로 죽지 않도록 자식에 UTF-8 을 강제한다(W2 Windows 빌드 실패).
  env: { ...process.env, PYTHONUTF8: '1' },
})
if (r.status !== 0) process.exit(r.status ?? 1)
console.log('wheelhouse →', out)
