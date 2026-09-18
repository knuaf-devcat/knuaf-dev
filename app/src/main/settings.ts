import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '../shared/types'

const DEFAULTS: Settings = { recent: [], credit_shown_at: null, python_override: null }

function file(): string { return join(app.getPath('userData'), 'settings.json') }

export function loadSettings(): Settings {
  try {
    if (existsSync(file())) return { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf-8')) }
  } catch { /* corrupt settings fall back to defaults */ }
  return { ...DEFAULTS }
}

export function saveSettings(next: Partial<Settings>): Settings {
  const merged = { ...loadSettings(), ...next }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}

export function rememberRecent(root: string): Settings {
  const s = loadSettings()
  const recent = [root, ...s.recent.filter((r) => r !== root)].slice(0, 8)
  return saveSettings({ recent })
}
