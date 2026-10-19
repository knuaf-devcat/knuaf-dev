import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { managedPython } from './runtime'

/** app/ in a checkout (out/main → ../..); resources live next to it when packaged. */
export const APP_ROOT = resolve(__dirname, '..', '..')
import type { SidecarInfo } from '../shared/types'

/** Where the skill scripts live: repo checkout in dev, resources/skill in a packaged app. */
export function scriptsDir(): string {
  if (process.env.KNUAF_SCRIPTS_DIR) return process.env.KNUAF_SCRIPTS_DIR
  if (app.isPackaged) return join(process.resourcesPath, 'skill', 'scripts')
  return join(APP_ROOT, '..', 'skills', 'knuaf-dev', 'scripts')
}

export function sidecarDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'sidecar')
  return join(APP_ROOT, 'sidecar')
}

export function bundledPython(): string | null {
  // e2e 전용: 개발 빌드에서만 번들을 없는 것으로 친다(번들이 있는 기계에서도 "번들 없음"
  // 장면을 그대로 재현하기 위함). 설치본에서는 이 변수를 읽지 않는다(D10 과 같은 경계).
  if (!app.isPackaged && process.env.KNUAF_NO_BUNDLE === '1') return null
  const base = app.isPackaged ? join(process.resourcesPath, 'python') : join(APP_ROOT, 'resources', 'python')
  const candidates = process.platform === 'win32' ? [join(base, 'python.exe')] : [join(base, 'bin', 'python3'), join(base, 'bin', 'python3.12')]
  return candidates.find((c) => existsSync(c)) ?? null
}

/**
 * `.venv/pyvenv.cfg` 가 말하는 Python 버전(major.minor). 읽을 수 없으면 null —
 * "모른다"를 "낡았다"로 바꾸지 않는다(그러면 멀쩡한 venv 를 건너뛴다).
 */
function venvVersion(projectRoot: string): [number, number] | null {
  try {
    const cfg = readFileSync(join(projectRoot, '.venv', 'pyvenv.cfg'), 'utf-8')
    for (const line of cfg.split(/\r?\n/)) {
      const m = /^\s*(?:version|version_info)\s*=\s*(\d+)\.(\d+)/i.exec(line)
      if (m) return [Number(m[1]), Number(m[2])]
    }
  } catch { /* cfg 없음·읽기 실패: 판정하지 않는다 */ }
  return null
}

/**
 * 프로젝트 venv 인터프리터. 3.10 미만으로 만들어진 것이 **읽히면** 건너뛴다(PY-D1-02) —
 * 그 실행기로는 사이드카가 `python_too_old` 로 죽고, 학생이 할 수 있는 일이 없다.
 * 읽을 수 없는 cfg 는 기존대로 선택한다(모르는 것을 낡았다고 단정하지 않는다).
 */
export function venvPython(projectRoot: string | null): string | null {
  if (!projectRoot) return null
  const version = venvVersion(projectRoot)
  if (version && (version[0] < 3 || (version[0] === 3 && version[1] < 10))) return null
  const candidates = process.platform === 'win32'
    ? [join(projectRoot, '.venv', 'Scripts', 'python.exe')]
    : [join(projectRoot, '.venv', 'bin', 'python3'), join(projectRoot, '.venv', 'bin', 'python')]
  return candidates.find((c) => existsSync(c)) ?? null
}

/**
 * Interpreter choice: explicit override, project venv, managed runtime, bundled runtime, PATH.
 * 관리 런타임은 사용자가 버튼을 눌렀을 때만 생기므로 번들보다 앞이다 — 번들이 깨진
 * 설치본에서도 버튼이 실제로 효과가 있어야 한다(D6).
 */
export function choosePython(projectRoot: string | null, override: string | null): Pick<SidecarInfo, 'python' | 'kind'> {
  if (override && existsSync(override)) return { python: override, kind: 'env' }
  if (process.env.KNUAF_PYTHON && existsSync(process.env.KNUAF_PYTHON)) return { python: process.env.KNUAF_PYTHON, kind: 'env' }
  const venv = venvPython(projectRoot)
  if (venv) return { python: venv, kind: 'venv' }
  const managed = managedPython()
  if (managed) return { python: managed, kind: 'managed' }
  const bundled = bundledPython()
  if (bundled) return { python: bundled, kind: 'bundled' }
  return { python: process.platform === 'win32' ? 'python' : 'python3', kind: 'path' }
}

/** The interpreter that gg_deps.py ensure should use as the venv base: never the venv itself. */
export function basePython(override: string | null): string {
  if (override && existsSync(override)) return override
  if (process.env.KNUAF_PYTHON && existsSync(process.env.KNUAF_PYTHON)) return process.env.KNUAF_PYTHON
  return managedPython() ?? bundledPython() ?? (process.platform === 'win32' ? 'python' : 'python3')
}

export function wheelhouseDir(): string | null {
  const dir = app.isPackaged ? join(process.resourcesPath, 'wheelhouse') : join(APP_ROOT, 'resources', 'wheelhouse')
  return existsSync(dir) ? dir : null
}
