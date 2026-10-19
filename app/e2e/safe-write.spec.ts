/**
 * WIN-ONEDRIVE 회귀 시험 — Node 단위(Electron 창 없이). `connect.spec.ts` 관례를 따른다.
 *
 * 윈도우에서 논문 폴더가 OneDrive 동기화 폴더면 `renameSync` 가 `EPERM` 으로 막히고, 그 예외가
 * main 의 이벤트 콜백에서 올라오면 Electron 오류 창("A JavaScript error occurred in the main
 * process")이 떴다(형님 실기). 여기서 고정하는 것은 **던지지 않는다**는 성질과 그 대가로 얻는
 * 내용 보존이다: 재시도 → 직접 쓰기 폴백 → 실패 반환, `.tmp` 잔여물 없음.
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { skillSource } from '../src/main/agent'
import { renameWithRetry, writeFileAtomic, type SafeWriteFs, type WriteResult } from '../src/main/safeWrite'
import type { ChatSnapshot } from '../src/shared/chat'

const appRoot = resolve(__dirname, '..')
const source = skillSource(appRoot, false, '/nonexistent')

const eperm = (): Error => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

/** 파일시스템 대역 — rename 을 정해진 횟수만큼 EPERM 으로 막는다. */
function stubFs(opts: { failRename?: number; failWrite?: boolean } = {}): {
  fs: SafeWriteFs
  files: Map<string, string>
  renames: () => number
} {
  const files = new Map<string, string>()
  let left = opts.failRename ?? 0
  let renames = 0
  const fs: SafeWriteFs = {
    writeFileSync: ((p: string, data: string) => {
      if (opts.failWrite) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      files.set(String(p), String(data))
    }) as unknown as SafeWriteFs['writeFileSync'],
    renameSync: ((from: string, to: string) => {
      renames++
      if (left > 0) { left--; throw eperm() }
      const v = files.get(String(from))
      if (v !== undefined) { files.set(String(to), v); files.delete(String(from)) }
    }) as unknown as SafeWriteFs['renameSync'],
    unlinkSync: ((p: string) => { files.delete(String(p)) }) as unknown as SafeWriteFs['unlinkSync']
  }
  return { fs, files, renames: () => renames }
}

const NO_WAIT = [0, 0, 0, 0]

test('막힌 이름 바꾸기는 짧게 다시 시도하고, 풀리면 원자적으로 저장한다', () => {
  const { fs, files, renames } = stubFs({ failRename: 2 })
  const r = writeFileAtomic('/p/chat.json', 'BODY', { fs, delaysMs: NO_WAIT })
  expect(r).toEqual({ ok: true })                      // 폴백이 아니라 원자적 성공
  expect(files.get('/p/chat.json')).toBe('BODY')
  expect(files.has('/p/chat.json.tmp'), '.tmp 잔여물이 남았다').toBe(false)
  expect(renames(), '두 번 막힌 뒤 세 번째에 성공해야 한다').toBe(3)
})

test('계속 막히면 직접 쓰기로 내려간다 — 내용은 남고 .tmp 는 치운다', () => {
  const { fs, files } = stubFs({ failRename: 99 })
  const logs: string[] = []
  const r = writeFileAtomic('/p/chat.json', 'BODY', { fs, delaysMs: NO_WAIT, log: (m) => logs.push(m) })
  expect(r).toEqual({ ok: true, fallback: true })
  expect(files.get('/p/chat.json')).toBe('BODY')
  expect(files.has('/p/chat.json.tmp'), '.tmp 잔여물이 남았다').toBe(false)
  expect(logs.join('\n'), '폴백 사실을 남긴다').toContain('직접 썼어요')
})

test('직접 쓰기까지 막히면 던지지 않고 실패를 돌려준다', () => {
  const { fs, files } = stubFs({ failRename: 99, failWrite: true })
  const logs: string[] = []
  let r: WriteResult | undefined
  expect(() => { r = writeFileAtomic('/p/chat.json', 'BODY', { fs, delaysMs: [0], log: (m) => logs.push(m) }) }).not.toThrow()
  expect(r?.ok).toBe(false)
  expect(files.size, '실패했는데 무언가 남겼다').toBe(0)
  expect(logs.join('\n'), '실패 사실을 남긴다').toContain('저장하지 못했어요')
})

test('다시 시도해 볼 만한 오류가 아니면 곧바로 폴백한다', () => {
  // ENOENT(폴더 없음)는 잠깐 막힌 것이 아니다 — 세 번 재시도하면 main 을 300ms 붙잡는다.
  const files = new Map<string, string>()
  let writes = 0
  const fs: SafeWriteFs = {
    writeFileSync: ((p: string, d: string) => { writes++; files.set(String(p), String(d)) }) as unknown as SafeWriteFs['writeFileSync'],
    renameSync: ((_f: string, _t: string) => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }) as unknown as SafeWriteFs['renameSync'],
    unlinkSync: ((p: string) => { files.delete(String(p)) }) as unknown as SafeWriteFs['unlinkSync']
  }
  const r = writeFileAtomic('/p/chat.json', 'BODY', { fs, delaysMs: NO_WAIT, log: () => {} })
  expect(r).toEqual({ ok: true, fallback: true })      // tmp 쓰기 1 + 직접 쓰기 1
  expect(writes).toBe(2)
})

test('폴더 이동(이름 바꾸기 전용)은 재시도하고, 끝까지 막히면 던진다', () => {
  const ok = stubFs({ failRename: 2 })
  expect(() => renameWithRetry('/a/skills/old', '/b/old', { fs: ok.fs, delaysMs: [0, 0, 0] })).not.toThrow()
  expect(ok.renames()).toBe(3)

  const stuck = stubFs({ failRename: 99 })
  expect(() => renameWithRetry('/a/old', '/b/old', { fs: stuck.fs, delaysMs: [0] })).toThrow(/EPERM/)
})

// ---------------------------------------------------------------- 제품 경로 (publish·flushDrafts)

/** 읽기만 되는 폴더를 만든다 — "저장이 계속 실패하는" 실제 조건(대역이 아니라 진짜 fs). */
function readOnlyProject(): { root: string; dir: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'kd-win-drive-'))
  const dir = join(root, '.knuaf-gui')
  mkdirSync(dir, { recursive: true })
  return { root, dir, file: join(dir, 'chat-codex.json') }
}

const service = (emit: (s: ChatSnapshot) => void): ChatService =>
  new ChatService({ skillSource: source, userData: mkdtempSync(join(tmpdir(), 'kd-win-ud-')), emit, openExternal: async () => {} })

test('이름 바꾸기가 계속 막히면 직접 쓰기로 내려가 내용을 남긴다 (실제 fs: 읽기 전용 폴더)', () => {
  const { root, dir, file } = readOnlyProject()
  // 앱이 작업 중 종료된 기록 — snapshot() 이 복구 상태를 곧바로 publish 한다(실제 호출 경로).
  writeFileSync(file, JSON.stringify({ root, provider: 'codex', state: 'running', messages: [{ id: 'u1', role: 'user', text: '안녕', at: '2026-10-19T00:00:00Z', delivery: 'pending' }] }))
  // 폴더에 쓸 수 없다 = **새 파일(.tmp)을 만들 수 없다** → rename 이 EACCES 로 막힌다.
  // 기존 파일 자체는 쓸 수 있으므로 직접 쓰기 폴백이 내용을 남긴다 — OneDrive·백신이 흔히 만드는 조건이다.
  chmodSync(dir, 0o500)
  const emitted: ChatSnapshot[] = []
  const svc = service((s) => emitted.push(s))
  try {
    let s: ChatSnapshot | undefined
    expect(() => { s = svc.snapshot(root, 'codex') }).not.toThrow()   // main 이벤트 콜백에서 올라가던 예외
    expect(s?.state).toBe('interrupted')                              // 메모리 상태는 진행된다
    expect(emitted, '저장 실패가 화면 흐름을 막았다').toHaveLength(1)
    expect(existsSync(file + '.tmp'), '.tmp 잔여물이 남았다').toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).state, 'rename 이 막혔는데 내용이 남지 않았다').toBe('interrupted')
  } finally {
    chmodSync(dir, 0o700)
  }
})

test('직접 쓰기까지 막히면 던지지 않고, 화면 스냅샷은 그대로 나간다', () => {
  const { root, dir, file } = readOnlyProject()
  writeFileSync(file, JSON.stringify({ root, provider: 'codex', state: 'running', messages: [{ id: 'u1', role: 'user', text: '안녕', at: '2026-10-19T00:00:00Z', delivery: 'pending' }] }))
  chmodSync(dir, 0o500)
  chmodSync(file, 0o400)   // 폴더에도 파일에도 쓸 수 없다 — tmp 도 직접 쓰기도 모두 막힌다
  const emitted: ChatSnapshot[] = []
  const svc = service((s) => emitted.push(s))
  try {
    expect(() => svc.snapshot(root, 'codex')).not.toThrow()
    expect(emitted, '저장이 실패해도 화면으로는 나가야 한다').toHaveLength(1)
    expect(existsSync(file + '.tmp'), '.tmp 잔여물이 남았다').toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).state, '저장이 실패했는데 파일이 바뀌었다').toBe('running')
  } finally {
    chmodSync(file, 0o600)
    chmodSync(dir, 0o700)
  }
})

test('초안 저장이 실패하면 값을 지우지 않는다 — 다음 flush 가 다시 시도한다', () => {
  const { root, dir, file } = readOnlyProject()
  const svc = service(() => {})
  chmodSync(dir, 0o500)
  try {
    svc.setDraft(root, '쓰다 만 글')
    expect(() => svc.flushDrafts()).not.toThrow()
    expect(svc.draft(root), '저장에 실패했는데 메모리 값까지 잃었다').toBe('쓰다 만 글')
    expect(existsSync(join(dir, 'draft.txt'))).toBe(false)
  } finally {
    chmodSync(dir, 0o700)
  }
  // 막힘이 풀리면 다음 flush 가 값을 남기고 대기에서 지운다.
  svc.flushDrafts()
  expect(readFileSync(file.replace('chat-codex.json', 'draft.txt'), 'utf8')).toBe('쓰다 만 글')
  expect(svc.draft(root)).toBe('쓰다 만 글')
})