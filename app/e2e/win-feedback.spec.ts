/**
 * 형님 윈도우 실기 피드백(2026-10-19) 회귀 시험 — Node 단위(Electron 창 없이). `question.spec.ts` 관례.
 *
 * ① 폴더 준비 중 보낸 글은 거절되지 않고 기다렸다가 간다(빨간 알림이 남던 결함)
 * ② 남는 "저장·검사 중" 거절은 오류가 아니라 안내다
 * ③ 도우미 답변의 `**굵게**` 가 별표 그대로 보이지 않는다
 * ④ 앱 작업 폴더는 윈도우에서 숨김 속성을 받는다
 * (질문 카드는 `question.spec.ts` 의 "형님 윈도우 실기" 두 시험)
 */
import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, Fragment } from 'react'
import { useChat } from '../src/renderer/src/store/chat'
import { usePrep } from '../src/renderer/src/store/prep'
import { describeChatError, CHAT } from '../src/renderer/src/copy'
import { withBold } from '../src/renderer/src/inline'
import { APP_DIRS, forgetHidden, hideAppDirs } from '../src/main/hidden'
import type { ChatSnapshot, ConnectionStatus } from '../src/shared/chat'

const CONNECTED: ConnectionStatus = { installed: true, connected: true, version: '0.0.0-test', detail: '' }
const ROOT = '/p/prep'
const snap = (root = ROOT): ChatSnapshot => ({ root, provider: 'codex', state: 'idle', messages: [] })

function harness() {
  const sent: string[] = []
  const api = {
    chat: {
      setDraft: async () => ({ result: true }),
      send: async (root: string, _p: string, text: string) => { sent.push(text); return { result: { ...snap(root), state: 'running' } } }
    }
  }
  ;(globalThis as unknown as { window: unknown }).window = { knuaf: { ...api, chat: { ...api.chat,
    snapshot: async (root: string) => ({ result: snap(root) }),
    status: async () => ({ result: CONNECTED }),
    draft: async () => ({ result: '' }) } } }
  usePrep.setState({ counts: {} })
  useChat.setState({ root: ROOT, provider: 'codex', snapshot: snap(), status: CONNECTED, draft: '', draftSeq: 0, busy: false, waitingPrep: false, error: null })
  return { sent }
}

test('① 폴더 준비 중 보낸 첫 마디는 거절되지 않고, 준비가 끝나면 그대로 간다', async () => {
  const h = harness()
  usePrep.getState().begin(ROOT)
  const sending = useChat.getState().send('시작하기')
  await new Promise((r) => setTimeout(r, 20))
  expect(h.sent, '준비 중인데 main 으로 보냈다(거절된다)').toEqual([])
  expect(useChat.getState().waitingPrep).toBe(true)
  expect(useChat.getState().busy, '기다리는 동안 다시 누를 수 있다').toBe(true)
  usePrep.getState().end(ROOT)
  expect(await sending).toBe(true)
  expect(h.sent).toEqual(['시작하기'])
  expect(useChat.getState().waitingPrep).toBe(false)
  expect(useChat.getState().error, '알림이 남았다').toBeNull()
})

test('① 기다리는 사이 다른 논문을 열면 보내지 않고, 그 논문은 잠기지 않는다 (검토 WINFB-R1-01)', async () => {
  const h = harness()
  usePrep.getState().begin(ROOT)
  const sending = useChat.getState().send('A 에서 보낸 답')
  await useChat.getState().load('/p/other')
  expect(await sending, 'A 를 떠났는데 대기가 끝나지 않았다').toBe(false)
  expect(useChat.getState().busy, 'B 가 A 의 대기에 잠겼다').toBe(false)
  expect(useChat.getState().waitingPrep, 'B 에 A 의 진행 표시가 남았다').toBe(false)
  expect(await useChat.getState().send('B 에서 보낸 답')).toBe(true)
  usePrep.getState().end(ROOT)
  await new Promise((r) => setTimeout(r, 20))
  expect(h.sent, 'A 의 옛 요청이 나갔다').toEqual(['B 에서 보낸 답'])
})

test('① A→B→A 로 돌아와도 떠나기 전의 요청은 되살아나지 않는다 (검토 WINFB-R1-01)', async () => {
  const h = harness()
  usePrep.getState().begin(ROOT)
  const sending = useChat.getState().send('전환 전에 보낸 답')
  await useChat.getState().load('/p/other')
  await useChat.getState().load(ROOT)
  usePrep.getState().end(ROOT)
  expect(await sending).toBe(false)
  expect(h.sent).toEqual([])
  expect(useChat.getState().busy).toBe(false)
})

test('① 같은 폴더의 준비가 겹치면 모두 끝나야 보낸다 (검토 WINFB-R1-01 보조)', async () => {
  const h = harness()
  usePrep.getState().begin(ROOT)
  usePrep.getState().begin(ROOT)          // 폴더를 다시 열어 준비가 한 번 더 돈다
  const sending = useChat.getState().send('시작하기')
  usePrep.getState().end(ROOT)            // 하나만 끝남
  await new Promise((r) => setTimeout(r, 20))
  expect(h.sent, '준비가 남았는데 보냈다').toEqual([])
  usePrep.getState().end(ROOT)
  expect(await sending).toBe(true)
  expect(h.sent).toEqual(['시작하기'])
})

test('① 다른 폴더가 준비 중이면 기다리지 않는다', async () => {
  const h = harness()
  usePrep.getState().begin('/p/elsewhere')
  expect(await useChat.getState().send('시작하기')).toBe(true)
  expect(h.sent).toEqual(['시작하기'])
  usePrep.getState().end('/p/elsewhere')
})

test('② "저장·검사 중" 거절은 빨간 오류가 아니라 기다리면 되는 안내다', () => {
  const d = describeChatError('앱이 저장·검사 작업 중이에요. 끝난 뒤 답변을 보내 주세요.')
  expect(d.kind).toBe('warning')
  expect(d.title).toBe(CHAT.appBusyTitle)
  expect(d.raw).toContain('저장·검사')
})

const html = (text: string): string => renderToStaticMarkup(createElement(Fragment, null, withBold(text, (part) => part)))
const html2 = (text: string, rest: (p: string) => string): string => renderToStaticMarkup(createElement(Fragment, null, withBold(text, rest)))

test('③ 도우미 답변의 **굵게** 는 별표 없이 굵은 글씨로 보인다', () => {
  expect(html('먼저 **전공**을 정해요')).toBe('먼저 <strong>전공</strong>을 정해요')
  expect(html('**[Q2-1] 기본 계획**\n1) 전공')).toBe('<strong>[Q2-1] 기본 계획</strong>\n1) 전공')
  // 짝이 없는 별표는 감추지 않는다. 줄을 넘는 짝도 굵게 만들지 않는다.
  expect(html('2 ** 3 = 8')).toBe('2 ** 3 = 8')
  expect(html('**앞\n뒤**')).toBe('**앞\n뒤**')
  // 굵게 밖의 글은 원래 그리던 함수가 그린다(파일 링크 등).
  const marked = renderToStaticMarkup(createElement(Fragment, null, withBold('**제목** 본문', (p) => p ? createElement('i', null, p) : p)))
  expect(marked).toBe('<strong><i>제목</i></strong><i> 본문</i>')
  // 굵은 글 안의 파일 링크도 같은 함수가 그린다 — 링크가 글자로 남지 않는다(검토 WINFB-R1-02).
  const link = (p: string) => p.replace(/\[([^\]]+)\]\([^)]+\)/g, '<$1>')
  expect(html2('결과: [일반](a.docx) 및 **[굵은](b.docx)**', link)).toBe('결과: &lt;일반&gt; 및 <strong>&lt;굵은&gt;</strong>')
})

function appFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'kd-hide-'))
  for (const name of APP_DIRS) mkdirSync(join(root, name))
  mkdirSync(join(root, '내 자료'))
  return root
}

test('④ 윈도우에서는 앱 작업 폴더 넷에만 숨김 속성을 붙이고, 한 번만 부른다', () => {
  forgetHidden()
  const root = appFolder()
  const calls: string[][] = []
  const got = hideAppDirs(root, { platform: 'win32', run: (args) => { calls.push(args); return true } })
  expect(got).toEqual(APP_DIRS.map((n) => join(root, n)))
  expect(calls.every((a) => a[0] === '+h')).toBe(true)
  expect(calls.some((a) => a[1].endsWith('내 자료')), '학생 폴더를 숨겼다').toBe(false)
  expect(hideAppDirs(root, { platform: 'win32', run: (args) => { calls.push(args); return true } })).toEqual([])
  expect(calls).toHaveLength(APP_DIRS.length)
  // 맥·리눅스는 점 이름이 이미 숨김이다 — 아무것도 부르지 않는다.
  forgetHidden()
  expect(hideAppDirs(root, { platform: 'darwin', run: () => { throw new Error('부르면 안 된다') } })).toEqual([])
})

test('④ 숨기기가 실패해도 던지지 않고, 다음에 다시 시도한다', () => {
  forgetHidden()
  const root = appFolder()
  expect(() => hideAppDirs(root, { platform: 'win32', run: () => false })).not.toThrow()
  expect(hideAppDirs(root, { platform: 'win32', run: () => true })).toHaveLength(APP_DIRS.length)
})

test('④ 이 기계의 실제 동작 — 윈도우면 탐색기 숨김 속성이 실제로 붙는다', () => {
  forgetHidden()
  const root = appFolder()
  const got = hideAppDirs(root)
  if (process.platform !== 'win32') { expect(got).toEqual([]); return }
  expect(got).toHaveLength(APP_DIRS.length)
  for (const name of APP_DIRS) {
    const out = spawnSync('attrib', [join(root, name)], { encoding: 'utf8', windowsHide: true }).stdout
    expect(out.slice(0, 12), `${name} 에 숨김 속성(H)이 없다`).toContain('H')
  }
  const mine = spawnSync('attrib', [join(root, '내 자료')], { encoding: 'utf8', windowsHide: true }).stdout
  expect(mine.slice(0, 12), '학생 폴더를 숨겼다').not.toContain('H')
})
