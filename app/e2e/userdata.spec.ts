// Unit tests for src/main/userdata.ts — plain Playwright `test()` in Node, no Electron.
// 앱 표시이름이 바뀌면 userData 가 새 폴더로 이동한다. 이전 폴더의 settings.json —
// 최근 폴더·Python 설정·도우미 선택·신뢰 폴더 — 을 한 번 이어 받되, 새 폴더가 이미
// 있으면 건드리지 않고 옛 폴더는 삭제하지 않는다.
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateUserDataDir } from '../src/main/userdata'

const dir = () => mkdtempSync(join(tmpdir(), 'kd-ud-'))
const putSettings = (d: string, body: object) => { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'settings.json'), JSON.stringify(body), 'utf-8') }

test('copies settings.json from a legacy dir when the new one is empty', () => {
  const current = join(dir(), 'new')
  const legacy = join(dir(), 'old')
  putSettings(legacy, { recent: [{ root: '/x', opened_at: 't' }], helper_mode: 'claude-chat' })
  const from = migrateUserDataDir(current, [legacy])
  expect(from).toBe(join(legacy, 'settings.json'))
  expect(JSON.parse(readFileSync(join(current, 'settings.json'), 'utf-8')).helper_mode).toBe('claude-chat')
  // 옛 폴더는 삭제하지 않는다 — 복사만.
  expect(existsSync(join(legacy, 'settings.json'))).toBe(true)
})

test('does not overwrite a populated new dir, even when legacy has data', () => {
  const current = join(dir(), 'new')
  const legacy = join(dir(), 'old')
  putSettings(current, { recent: [{ root: '/new', opened_at: 't' }] })
  putSettings(legacy, { recent: [{ root: '/old', opened_at: 't' }] })
  expect(migrateUserDataDir(current, [legacy])).toBeNull()
  expect(JSON.parse(readFileSync(join(current, 'settings.json'), 'utf-8')).recent[0].root).toBe('/new')
})

test('empty legacy dirs are harmless and later names fall through', () => {
  const current = join(dir(), 'new')
  const emptyLegacy = join(dir(), 'old-empty')
  mkdirSync(emptyLegacy)
  const legacy = join(dir(), 'old')
  putSettings(legacy, { python_override: '/x/python3' })
  expect(migrateUserDataDir(current, [emptyLegacy, legacy])).toBe(join(legacy, 'settings.json'))
})

test('nothing to migrate when neither dir has settings', () => {
  const current = join(dir(), 'new')
  expect(migrateUserDataDir(current, [join(dir(), 'old')])).toBeNull()
  expect(existsSync(current)).toBe(false) // 아무 일도 없었으면 폴더도 만들지 않는다
})

test('migration is idempotent — a second run changes nothing', () => {
  const current = join(dir(), 'new')
  const legacy = join(dir(), 'old')
  putSettings(legacy, { helper_mode: 'codex-chat' })
  migrateUserDataDir(current, [legacy])
  writeFileSync(join(current, 'settings.json'), JSON.stringify({ helper_mode: 'claude-chat' }), 'utf-8')
  expect(migrateUserDataDir(current, [legacy])).toBeNull()
  expect(JSON.parse(readFileSync(join(current, 'settings.json'), 'utf-8')).helper_mode).toBe('claude-chat')
})
