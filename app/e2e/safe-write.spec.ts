/**
 * WIN-ONEDRIVE 회귀 시험 — Node 단위(Electron 창 없이). `connect.spec.ts` 관례를 따른다.
 *
 * 윈도우에서 논문 폴더가 OneDrive 동기화 폴더면 `renameSync` 가 `EPERM` 으로 막히고, 그 예외가
 * main 의 이벤트 콜백에서 올라오면 Electron 오류 창("A JavaScript error occurred in the main
 * process")이 떴다(형님 실기). 여기서 고정하는 것은 **던지지 않는다**는 성질과 **완전한 기록 하나는
 * 언제나 남는다**는 보존 규칙이다(WIN-ONEDRIVE-R1-01): 완성된 `.tmp` 없이 대상을 덮지 않고, 직접
 * 쓰기가 중간에 실패하면 `.tmp` 를 남겨 읽는 쪽이 되살린다.
 *
 * 실패는 폴더 권한(chmod)이 아니라 **fs 대역**으로 만든다 — 윈도우에서는 폴더 읽기 전용 속성이
 * 쓰기를 막지 않아 같은 시험이 다른 뜻이 된다(R1-03). 제품 경로 시험은 실제 파일시스템을 감싼
 * 대역을 `ChatService` 의 시험 이음매(`fs`)로 넣는다.
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { skillSource } from '../src/main/agent'
import { readRecoverable, renameWithRetry, writeFileAtomic, type SafeWriteFs, type WriteResult } from '../src/main/safeWrite'
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

test('.tmp 를 만들지 못하면 대상을 덮지 않는다 — 그때 완전한 기록은 대상뿐이다', () => {
  const files = new Map<string, string>([['/p/chat.json', 'OLD']])
  const fs: SafeWriteFs = {
    writeFileSync: ((p: string, d: string) => {
      if (String(p).endsWith('.tmp')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      files.set(String(p), String(d))
    }) as unknown as SafeWriteFs['writeFileSync'],
    renameSync: (() => { throw new Error('rename 까지 오면 안 된다') }) as unknown as SafeWriteFs['renameSync'],
    unlinkSync: ((p: string) => { files.delete(String(p)) }) as unknown as SafeWriteFs['unlinkSync']
  }
  const r = writeFileAtomic('/p/chat.json', 'NEW', { fs, delaysMs: NO_WAIT, log: () => {} })
  expect(r.ok).toBe(false)
  expect(files.get('/p/chat.json'), '완성본 없이 대상을 덮었다').toBe('OLD')
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

// ---------------------------------------------------------------- 읽는 쪽 (readRecoverable)

const json = (t: string): { v: number } => { const v = JSON.parse(t) as { v: number }; if (typeof v.v !== 'number') throw new Error('모양이 다르다'); return v }

test('온전한 .tmp 가 있으면 그것이 최신 완성본이다 — 대상이 반쪽이든 옛것이든', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-recover-'))
  const file = join(dir, 'chat.json')
  writeFileSync(file + '.tmp', '{"v":2}')
  writeFileSync(file, '{"v":')                 // 직접 쓰기가 중간에 멈춘 반쪽 — 수정 시각은 .tmp 보다 나중이다
  expect(readRecoverable(file, json)).toEqual({ value: { v: 2 }, from: 'tmp' })
  writeFileSync(file, '{"v":1}')               // 직접 쓰기가 대상을 건드리기 전에 막힘
  expect(readRecoverable(file, json)).toEqual({ value: { v: 2 }, from: 'tmp' })
  unlinkSync(file + '.tmp')
  expect(readRecoverable(file, json)).toEqual({ value: { v: 1 }, from: 'file' })
})

test('되살릴 것이 없으면 망가진 대상은 오류로 거절하고, 처음부터 없으면 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-recover-'))
  const file = join(dir, 'chat.json')
  expect(readRecoverable(file, json)).toBeNull()
  writeFileSync(file + '.tmp', '{"v":')        // 반쪽 .tmp 만 있다 — 기록이 아니다
  expect(readRecoverable(file, json)).toBeNull()
  writeFileSync(file, '{"v":')
  expect(() => readRecoverable(file, json), '망가진 기록을 빈 것으로 바꿨다').toThrow()
})

// ---------------------------------------------------------------- 제품 경로 (publish·flushDrafts)

const enospc = (): Error => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
const eacces = (): Error => Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' })

/**
 * 실제 파일시스템을 감싸 정해진 자리만 실패시키는 대역. 실패는 플랫폼과 무관하게 같은 뜻이다.
 * `partial` 은 대상에 앞부분만 실제로 쓰고 ENOSPC 로 멈춘다 — 판정 R1-01 의 반례 그대로.
 */
function faultyFs(rule: { rename?: () => Error | null; write?: (path: string) => Error | 'partial' | null; unlink?: (path: string) => Error | null }): SafeWriteFs {
  return {
    writeFileSync: ((p: string, d: string, o?: object) => {
      const f = rule.write?.(String(p)) ?? null
      if (f === 'partial') { writeFileSync(p, String(d).slice(0, 20)); throw enospc() }
      if (f) throw f
      writeFileSync(p, d, o as never)
    }) as unknown as SafeWriteFs['writeFileSync'],
    renameSync: ((a: string, b: string) => { const f = rule.rename?.() ?? null; if (f) throw f; renameSync(a, b) }) as unknown as SafeWriteFs['renameSync'],
    unlinkSync: ((p: string) => { const f = rule.unlink?.(String(p)) ?? null; if (f) throw f; unlinkSync(p) }) as unknown as SafeWriteFs['unlinkSync']
  }
}

function project(): { root: string; dir: string; file: string; draft: string } {
  const root = mkdtempSync(join(tmpdir(), 'kd-win-drive-'))
  const dir = join(root, '.knuaf-gui')
  mkdirSync(dir, { recursive: true })
  return { root, dir, file: join(dir, 'chat-codex.json'), draft: join(dir, 'draft.txt') }
}

const service = (emit: (s: ChatSnapshot) => void, fs?: SafeWriteFs): ChatService =>
  new ChatService({ skillSource: source, userData: mkdtempSync(join(tmpdir(), 'kd-win-ud-')), emit, openExternal: async () => {}, fs })

/** 앱이 작업 중 종료된 기록 — snapshot() 이 복구 상태를 곧바로 publish 한다(실제 호출 경로). */
const RUNNING = (root: string): string => JSON.stringify({ root, provider: 'codex', state: 'running', messages: [
  { id: 'u0', role: 'user', text: '앞서 나눈 긴 대화', at: '2026-10-18T00:00:00Z', delivery: 'sent' },
  { id: 'u1', role: 'user', text: '안녕', at: '2026-10-19T00:00:00Z', delivery: 'pending' }
] })

test('rename 이 막히고 직접 쓰기가 중간에 실패해도 대화는 되살아난다 (R1-01 반례)', () => {
  const { root, file } = project()
  writeFileSync(file, RUNNING(root))
  const emitted: ChatSnapshot[] = []
  const svc = service((s) => emitted.push(s), faultyFs({
    rename: eperm,                                          // OneDrive 가 교체를 계속 막는다
    write: (p) => (p === file ? 'partial' : null)           // 대상 직접 쓰기는 20바이트 뒤 ENOSPC
  }))
  let s: ChatSnapshot | undefined
  expect(() => { s = svc.snapshot(root, 'codex') }).not.toThrow()   // main 이벤트 콜백에서 올라가던 예외
  expect(s?.state).toBe('interrupted')
  expect(emitted, '저장 실패가 화면 흐름을 막았다').toHaveLength(1)
  expect(() => JSON.parse(readFileSync(file, 'utf8')), '반례가 대상을 반쪽으로 만들지 못했다(시험 전제)').toThrow()
  expect(existsSync(file + '.tmp'), '유일한 완성본(.tmp)을 지웠다').toBe(true)

  // 앱을 다시 띄운다(실제 fs) — 반쪽 대상 대신 .tmp 의 완성본을 읽고, 제자리로 되돌린다.
  const again = service(() => {}).snapshot(root, 'codex')
  expect(again.state).toBe('interrupted')
  expect(again.messages.map((m) => m.text), '저장했던 대화를 잃었다').toEqual(['앞서 나눈 긴 대화', '안녕'])
  expect(JSON.parse(readFileSync(file, 'utf8')).messages, '되살린 기록이 제자리로 돌아가지 않았다').toHaveLength(2)
  expect(existsSync(file + '.tmp')).toBe(false)
})

test('대상이 반쪽인 채 다음 저장의 .tmp 쓰기가 막혀도 남은 완성본을 지우지 않는다', () => {
  const { root, file } = project()
  writeFileSync(file, RUNNING(root))
  // 첫 저장: rename 막힘 → 직접 쓰기가 반쪽에서 멈춤 → 완성본은 .tmp 에만 있다.
  const first = service(() => {}, faultyFs({ rename: eperm, write: (p) => (p === file ? 'partial' : null) }))
  first.snapshot(root, 'codex')
  const kept = readFileSync(file + '.tmp', 'utf8')
  // 다음 실행: .tmp 에서 되살린 기록을 제자리로 되돌리려 하지만 .tmp 쓰기가 열기에서 막힌다.
  const emitted: ChatSnapshot[] = []
  const second = service((s) => emitted.push(s), faultyFs({ write: (p) => (p.endsWith('.tmp') ? eperm() : null) }))
  expect(() => second.snapshot(root, 'codex')).not.toThrow()
  expect(emitted).toHaveLength(1)
  expect(existsSync(file + '.tmp'), '유일한 완성본(.tmp)을 지웠다').toBe(true)
  expect(readFileSync(file + '.tmp', 'utf8')).toBe(kept)
  expect(service(() => {}).snapshot(root, 'codex').messages, '저장했던 대화를 잃었다').toHaveLength(2)
})

test('rename 이 계속 막히면 직접 쓰기로 내용을 남긴다 (서비스 경로의 rename EPERM)', () => {
  const { root, file } = project()
  writeFileSync(file, RUNNING(root))
  const emitted: ChatSnapshot[] = []
  const svc = service((s) => emitted.push(s), faultyFs({ rename: eperm }))
  expect(() => svc.snapshot(root, 'codex')).not.toThrow()
  expect(emitted).toHaveLength(1)
  expect(JSON.parse(readFileSync(file, 'utf8')).state, 'rename 이 막혔는데 내용이 남지 않았다').toBe('interrupted')
  expect(existsSync(file + '.tmp'), '.tmp 잔여물이 남았다').toBe(false)
})

test('.tmp 를 만들 수 없으면(EACCES) 던지지 않고, 기존 기록은 손대지 않는다', () => {
  const { root, file } = project()
  writeFileSync(file, RUNNING(root))
  const emitted: ChatSnapshot[] = []
  const svc = service((s) => emitted.push(s), faultyFs({ write: (p) => (p.endsWith('.tmp') ? eacces() : null) }))
  expect(() => svc.snapshot(root, 'codex')).not.toThrow()
  expect(emitted, '저장이 실패해도 화면으로는 나가야 한다').toHaveLength(1)
  expect(JSON.parse(readFileSync(file, 'utf8')).state, '완성본 없이 대상을 덮었다').toBe('running')
  expect(existsSync(file + '.tmp')).toBe(false)
})

test('초안 저장이 막히면 값을 지우지 않는다 — 풀린 뒤 다음 flush 가 남긴다', () => {
  const { root, draft } = project()
  let blocked = true
  const svc = service(() => {}, faultyFs({ write: (p) => (blocked && p.startsWith(draft) ? eacces() : null) }))
  svc.setDraft(root, '쓰다 만 글')
  expect(() => svc.flushDrafts()).not.toThrow()
  expect(svc.draft(root), '저장에 실패했는데 메모리 값까지 잃었다').toBe('쓰다 만 글')
  expect(existsSync(draft)).toBe(false)
  blocked = false
  svc.flushDrafts()
  expect(readFileSync(draft, 'utf8')).toBe('쓰다 만 글')
  expect(svc.draft(root)).toBe('쓰다 만 글')
})

test('빈 초안의 삭제가 막혀도 보낸 글이 되살아나지 않는다 (R1-02)', () => {
  const { root, draft } = project()
  writeFileSync(draft, '이미 전송한 글')
  let blocked = true
  const svc = service(() => {}, faultyFs({ unlink: (p) => (blocked && p === draft ? eperm() : null) }))
  svc.setDraft(root, '')                                  // 전송 성공 뒤 화면이 초안을 비운다
  expect(() => svc.flushDrafts()).not.toThrow()
  expect(svc.draft(root), '삭제가 막혔는데 보낸 글이 되살아났다').toBe('')
  expect(existsSync(draft)).toBe(true)
  blocked = false
  svc.flushDrafts()                                       // 대기가 남아 있어 다시 지운다
  expect(existsSync(draft), '잠금이 풀린 뒤에도 지우지 않았다').toBe(false)
  expect(svc.draft(root)).toBe('')
})

test('초안 직접 쓰기가 중간에 실패해도 다음 실행이 .tmp 에서 되살린다', () => {
  const { root, draft } = project()
  writeFileSync(draft, '예전 글')
  const svc = service(() => {}, faultyFs({ rename: eperm, write: (p) => (p === draft ? 'partial' : null) }))
  svc.setDraft(root, '새로 쓴 글 — 스무 바이트를 넘는 문장입니다')
  svc.flushDrafts()
  expect(existsSync(draft + '.tmp'), '유일한 완성본(.tmp)을 지웠다').toBe(true)

  const again = service(() => {})
  expect(again.draft(root)).toBe('새로 쓴 글 — 스무 바이트를 넘는 문장입니다')
  again.flushDrafts()                                     // 되살린 값을 제자리로
  expect(readFileSync(draft, 'utf8')).toBe('새로 쓴 글 — 스무 바이트를 넘는 문장입니다')
  expect(existsSync(draft + '.tmp')).toBe(false)
})
