import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'

/** app/ in a checkout (out/main → ../..); resources live next to it when packaged. */
const APP_ROOT = resolve(__dirname, '..', '..')
import type { SidecarInfo } from '../shared/types'

/** Where the skill scripts live: repo checkout in dev, resources/skill in a packaged app. */
export function scriptsDir(): string {
  if (process.env.KNUAF_SCRIPTS_DIR) return process.env.KNUAF_SCRIPTS_DIR
  if (app.isPackaged) return join(process.resourcesPath, 'skill', 'scripts')
  return join(APP_ROOT, '..', 'skills', 'knuaf-doc', 'scripts')
}

export function sidecarDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'sidecar')
  return join(APP_ROOT, 'sidecar')
}

export function bundledPython(): string | null {
  const base = app.isPackaged ? join(process.resourcesPath, 'python') : join(APP_ROOT, 'resources', 'python')
  const candidates = process.platform === 'win32' ? [join(base, 'python.exe')] : [join(base, 'bin', 'python3'), join(base, 'bin', 'python3.12')]
  return candidates.find((c) => existsSync(c)) ?? null
}

export function venvPython(projectRoot: string | null): string | null {
  if (!projectRoot) return null
  const candidates = process.platform === 'win32'
    ? [join(projectRoot, '.venv', 'Scripts', 'python.exe')]
    : [join(projectRoot, '.venv', 'bin', 'python3'), join(projectRoot, '.venv', 'bin', 'python')]
  return candidates.find((c) => existsSync(c)) ?? null
}

/** Interpreter choice, in priority order: explicit override, project venv, bundled runtime, PATH (dev only). */
export function choosePython(projectRoot: string | null, override: string | null): Pick<SidecarInfo, 'python' | 'kind'> {
  if (override && existsSync(override)) return { python: override, kind: 'env' }
  if (process.env.KNUAF_PYTHON && existsSync(process.env.KNUAF_PYTHON)) return { python: process.env.KNUAF_PYTHON, kind: 'env' }
  const venv = venvPython(projectRoot)
  if (venv) return { python: venv, kind: 'venv' }
  const bundled = bundledPython()
  if (bundled) return { python: bundled, kind: 'bundled' }
  return { python: process.platform === 'win32' ? 'python' : 'python3', kind: 'path' }
}

/** The interpreter that gg_deps.py ensure should use as the venv base: never the venv itself. */
export function basePython(override: string | null): string {
  if (override && existsSync(override)) return override
  if (process.env.KNUAF_PYTHON && existsSync(process.env.KNUAF_PYTHON)) return process.env.KNUAF_PYTHON
  return bundledPython() ?? (process.platform === 'win32' ? 'python' : 'python3')
}

export function wheelhouseDir(): string | null {
  const dir = app.isPackaged ? join(process.resourcesPath, 'wheelhouse') : join(APP_ROOT, 'resources', 'wheelhouse')
  return existsSync(dir) ? dir : null
}
