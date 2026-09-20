import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecentEntry, Settings } from '../shared/types'

const DEFAULTS: Settings = { recent: [], credit_shown_at: null, python_override: null }
const RECENT_MAX = 8

function file(): string { return join(app.getPath('userData'), 'settings.json') }

/** Accepts legacy `string[]` entries and anything malformed; always yields `{ root, opened_at }[]`. */
function normaliseRecent(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return []
  const out: RecentEntry[] = []
  for (const item of raw) {
    let entry: RecentEntry | null = null
    if (typeof item === 'string' && item) entry = { root: item, opened_at: '' }
    else if (item && typeof item === 'object' && typeof (item as { root?: unknown }).root === 'string' && (item as { root: string }).root) {
      const opened = (item as { opened_at?: unknown }).opened_at
      entry = { root: (item as { root: string }).root, opened_at: typeof opened === 'string' ? opened : '' }
    }
    if (entry && !out.some((e) => e.root === entry!.root)) out.push(entry)
  }
  return out.slice(0, RECENT_MAX)
}

/**
 * helper_mode migrations: the legacy `codex_terminal` checkbox and the removed in-app
 * terminal modes ('codex-term'/'claude-term'). Terminal picks keep their provider —
 * a student who chose the Claude terminal lands on the Claude chat, not on Codex.
 */
function migrateHelperMode(parsed: Partial<Settings>): Settings['helper_mode'] {
  const h = parsed.helper_mode as string | undefined
  if (h === 'codex-chat' || h === 'claude-chat') return h
  if (h === 'claude-term') return 'claude-chat'
  // 'codex-term'·codex_terminal===true → codex 채팅. 로드 시점에만 정규화한다 —
  // 디스크 값은 다음 settings 저장 때 새 값으로 덮인다.
  return 'codex-chat'
}

export function loadSettings(): Settings {
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), 'utf-8')) as Partial<Settings> & { recent?: unknown }
      return { ...DEFAULTS, ...parsed, recent: normaliseRecent(parsed.recent), helper_mode: migrateHelperMode(parsed) }
    }
  } catch { /* corrupt settings fall back to defaults */ }
  return { ...DEFAULTS, helper_mode: 'codex-chat' }
}

export function saveSettings(next: Partial<Settings>): Settings {
  const merged: Settings = { ...loadSettings(), ...next }
  if ('recent' in next) merged.recent = normaliseRecent(next.recent)
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}

export function rememberRecent(root: string): Settings {
  const s = loadSettings()
  const entry: RecentEntry = { root, opened_at: new Date().toISOString() }
  const recent = [entry, ...s.recent.filter((r) => r.root !== root)].slice(0, RECENT_MAX)
  return saveSettings({ recent })
}
