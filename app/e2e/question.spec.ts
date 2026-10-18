/**
 * 단계 1의 순수 함수와 초안 경합 — Node 단위 시험(Playwright 가 Electron 없이 돈다).
 *
 * 카드가 뜨는 조건과 초안 판정은 화면 조각마다 흩어지면 반례가 생긴다(v4 검토 R1-01).
 * 그래서 조건은 zone.ts 한 곳, 초안은 `draftAfterSend` 하나로 모으고 여기서 고정한다.
 */
import { expect, test } from '@playwright/test'
import { parseQuestion, optionAnswer, splitOption } from '../src/shared/question'
import { questionCardOf, waitingQuestionCount, zoneOf } from '../src/shared/zone'
import { draftAfterSend, useChat } from '../src/renderer/src/store/chat'
import type { ChatMessage, ChatSnapshot, ConnectionStatus } from '../src/shared/chat'
import type { Status } from '../src/shared/types'

const CONNECTED: ConnectionStatus = { installed: true, connected: true, version: '0.0.0-test', detail: '' }
const OFFLINE: ConnectionStatus = { installed: true, connected: false, version: null, detail: '로그인 필요' }

const Q = (id = 'Q3-2', options = ['농협 공판장', '온라인 직거래', '아직 몰라요 — 지역 판로를 찾아 제안해 드릴게요']) =>
  `[${id}] Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요\n\n지금 블루베리를 주로 어디에 팔고 있나요?\n\n${options
    .map((o, i) => `  ${i + 1}) ${o}`).join('\n')}\n\n→ 번호 또는 자유 입력`

function msg(over: Partial<ChatMessage> & { role: ChatMessage['role'] }): ChatMessage {
  return { id: Math.random().toString(36).slice(2), text: '', at: new Date().toISOString(), ...over }
}

function snap(messages: ChatMessage[], state: ChatSnapshot['state'] = 'idle'): ChatSnapshot {
  return { root: '/p', provider: 'codex', state, messages }
}

/** `tasks` 에 도우미가 기다리는 질문 하나를 가진 상태. */
function status(over: Partial<Status> = {}): Status {
  return {
    revision: 1, project_id: 'p', checks: [], gate: [],
    completion: { skill_ready: false, guideline_ready: null, professor_approval_pending: false, notice: '', user_finish_pending: [] },
    tasks: [{ id: 'task-interview', status: 'needs_user' }],
    lanes: {} as Status['lanes'], user_finish_pending: [], counts: {},
    ...over
  }
}

// --------------------------------------------------------------- parseQuestion

test('선택형 3~5개를 읽고 제목·질문·보기·장을 꺼낸다', () => {
  const parsed = parseQuestion(Q())
  expect(parsed).not.toBeNull()
  expect(parsed!.id).toBe('Q3-2')
  expect(parsed!.use).toBe('Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요')
  expect(parsed!.text).toBe('지금 블루베리를 주로 어디에 팔고 있나요?')
  expect(parsed!.options).toEqual(['농협 공판장', '온라인 직거래', '아직 몰라요 — 지역 판로를 찾아 제안해 드릴게요'])
  expect(parsed!.chapterHint).toBe('Ⅲ장')
  // 접을 범위는 보기 줄부터 바로 뒤 `→ …` 안내 줄까지.
  const lines = Q().split('\n')
  expect(lines[parsed!.span.start].trim()).toContain('1) 농협 공판장')
  expect(lines[parsed!.span.end].trim().startsWith('→')).toBe(true)
})

test('보기 2개와 5개는 읽고, 1개와 6개는 카드가 아니다', () => {
  expect(parseQuestion(Q('Q1-1', ['매입', '임차']))!.options).toHaveLength(2)
  expect(parseQuestion(Q('Q1-1', ['1', '2', '3', '4', '5']))!.options).toHaveLength(5)
  expect(parseQuestion(Q('Q1-1', ['매입']))).toBeNull()
  expect(parseQuestion(Q('Q1-1', ['1', '2', '3', '4', '5', '6']))).toBeNull()
})

test('번호가 1부터 연속이 아니면 카드가 아니다', () => {
  const text = '[Q3-2] 판매처\n\n어디에 파나요?\n\n  1) 농협\n  3) 온라인\n'
  expect(parseQuestion(text)).toBeNull()
})

test('값 입력형·서술형·머리 없음은 카드가 아니다', () => {
  // 값 입력형 — 보기 줄이 없다.
  expect(parseQuestion('[Q3-1] Ⅲ장 경영 규모에 쓰여요\n지금 재배 면적은 얼마인가요? (평 또는 ㎡)\n예: 600평 / 2,000㎡ / 아직 몰라요')).toBeNull()
  // 서술형 — 보기 줄이 없다.
  expect(parseQuestion('농장명을 짓게 된 배경을 알려달라.\n(관련 소개 절의 글감으로 사용한다. 짧게 답해도 된다)')).toBeNull()
  // 보기는 있는데 `[Qn-m]` 머리가 없다.
  expect(parseQuestion('어디에 파나요?\n\n  1) 농협\n  2) 온라인\n')).toBeNull()
})

test('한 메시지에 질문이 둘이면 마지막 것을 쓴다', () => {
  const text = `${Q('Q3-1', ['매입', '임차'])}\n\n${Q('Q3-2', ['농협 공판장', '온라인 직거래'])}`
  const parsed = parseQuestion(text)!
  expect(parsed.id).toBe('Q3-2')
  expect(parsed.options).toEqual(['농협 공판장', '온라인 직거래'])
})

test('보기 사이 질문 문장이 없으면 제목 줄이 질문이 된다', () => {
  const parsed = parseQuestion('[Q2-3] 부지 확보 방식\n\n  1) 매입\n  2) 임차\n')!
  expect(parsed.text).toBe('부지 확보 방식')
  expect(parsed.chapterHint).toBeNull()
})

test('` — ` 뒤 설명은 지우지 않고 나눠 보여 줄 뿐이다', () => {
  expect(splitOption('아직 몰라요 — 지역 판로를 찾아 제안해 드릴게요')).toEqual({ main: '아직 몰라요', note: '지역 판로를 찾아 제안해 드릴게요' })
  expect(splitOption('농협 공판장')).toEqual({ main: '농협 공판장', note: null })
  // 보낸 말은 스킬이 받는 형식 그대로 — 번호 + 보기 본문(설명은 뺀다).
  expect(optionAnswer(1, '온라인 직거래')).toBe('2) 온라인 직거래')
  expect(optionAnswer(2, '아직 몰라요 — 지역 판로를 찾아 제안해 드릴게요')).toBe('3) 아직 몰라요')
})

// --------------------------------------------------------------- zoneOf

test('카드 조건: 마지막 도우미 메시지가 질문이고 그 뒤에 학생 메시지가 없다', () => {
  const card = questionCardOf(snap([msg({ role: 'assistant', text: Q() })]), status())
  expect(card?.card.id).toBe('Q3-2')
  // 시스템 줄이 뒤에 붙어도(규칙집 갱신 안내) 카드는 그대로다.
  expect(questionCardOf(snap([msg({ role: 'assistant', text: Q() }), msg({ role: 'system', text: '규칙집이 갱신됐어요' })]), status())).not.toBeNull()
})

test('v4 R1-01 반례: 답한 뒤 uncertain 학생 메시지가 있으면 카드가 없다', () => {
  const messages = [
    msg({ role: 'assistant', text: Q() }),
    msg({ role: 'user', text: '2) 온라인 직거래', delivery: 'uncertain' })
  ]
  expect(questionCardOf(snap(messages), status())).toBeNull()
  expect(zoneOf(snap(messages), CONNECTED, status()).kind).toBe('composer')
})

test('한글 마무리만 남으면 카드가 아니다 (GUI-10)', () => {
  const finish: Status['user_finish_pending'] = [
    { id: 'font_shinmyeongjo', status: 'needs_user', owner: 'user', reason: '글꼴' },
    { id: 'margins', status: 'needs_user', owner: 'user', reason: '여백' }
  ]
  const withFinish = status({
    tasks: [{ id: 'font_shinmyeongjo', status: 'needs_user' }, { id: 'margins', status: 'needs_user' }],
    user_finish_pending: finish
  })
  expect(waitingQuestionCount(withFinish)).toBe(0)
  expect(questionCardOf(snap([msg({ role: 'assistant', text: Q() })]), withFinish)).toBeNull()
  // 같은 tasks 라도 한글 마무리 id 가 아니면 질문으로 센다.
  expect(waitingQuestionCount(status())).toBe(1)
})

test('허락이 질문보다 먼저, 실행 중에는 카드가 없다', () => {
  const question = msg({ role: 'assistant', text: Q() })
  const permission = { id: 'p1', title: '논문 폴더 밖의 파일을 건드리려고 해요', detail: 'cat /etc/hosts' }
  const withPermission = { ...snap([question]), state: 'permission' as const, permission }
  expect(zoneOf(withPermission, CONNECTED, status()).kind).toBe('permission')
  // 허락이 떠 있으면 질문 카드 자리를 내준다.
  expect(zoneOf({ ...snap([question]), state: 'running' as const }, CONNECTED, status()).kind).toBe('running')
})

test('끊겨 있으면 언제나 미연결 자리다', () => {
  expect(zoneOf(snap([msg({ role: 'assistant', text: Q() })]), null, status()).kind).toBe('disconnected')
  expect(zoneOf(snap([msg({ role: 'assistant', text: Q() })]), OFFLINE, status()).kind).toBe('disconnected')
})

test('카드를 만들 수 없으면 보통 입력칸이다', () => {
  expect(zoneOf(snap([msg({ role: 'assistant', text: '좋아요. 3,300㎡(약 1,000평)로 적었어요.' })]), CONNECTED, status()).kind).toBe('composer')
  // 질문은 있는데 도우미가 기다리는 질문이 없으면(이미 답한 것) 카드가 아니다.
  expect(zoneOf(snap([msg({ role: 'assistant', text: Q() })]), CONNECTED, status({ tasks: [] })).kind).toBe('composer')
})

// --------------------------------------------------------------- draftAfterSend

test('초안 판정은 편집 번호로 한다 — 같은 문장을 지웠다 다시 써도 구분된다', () => {
  expect(draftAfterSend(3, 3, '첫 답')).toBe('')          // 안 바뀜 → 비운다
  expect(draftAfterSend(3, 4, '다음 답')).toBe('다음 답')   // 바뀜 → 그대로 둔다
  expect(draftAfterSend(3, 5, '네')).toBe('네')             // 지웠다 다시 쓴 경우(문자열로는 같다)
})

// --------------------------------------------------------------- send() 경합

const ROOT = '/p/race'

function harness() {
  const persisted: string[] = []
  let pending: ((value: unknown) => void) | null = null
  const api = {
    chat: {
      snapshot: async () => ({ result: snap([]) }),
      status: async () => ({ result: CONNECTED }),
      draft: async () => ({ result: '' }),
      setDraft: async (_root: string, text: string) => { persisted.push(text); return { result: true } },
      send: () => new Promise((resolve) => { pending = resolve as (v: unknown) => void }),
      login: async () => ({ result: true }),
      respond: async () => ({ result: true }),
      stop: async () => ({ result: true })
    }
  }
  return {
    api,
    persisted,
    finish: (value: unknown) => { const p = pending; pending = null; p?.(value) },
    reset: () => useChat.setState({
      root: ROOT, provider: 'codex', snapshot: snap([]), status: CONNECTED, statusFailed: false,
      draft: '', draftSeq: 0, busy: false, error: null, mode: null
    })
  }
}

/** main 은 실행 중 스냅샷을 먼저 보내고 전송 응답을 나중에 돌려준다(service.ts). */
const ACCEPTED = { result: snap([msg({ role: 'user', text: '첫 답', delivery: 'sent' })], 'running') }
const REFUSED = { error: { code: 'busy', message: '앱이 저장·검사 작업 중이에요' } }

test('① 응답을 기다리는 동안 쓴 다음 말을 성공 응답이 지우지 않는다', async () => {
  const h = harness()
  ;(globalThis as unknown as { window: unknown }).window = { knuaf: h.api }
  h.reset()
  useChat.getState().setDraft('첫 답')
  const sending = useChat.getState().send()
  useChat.getState().setDraft('다음 답 초안')     // 학생이 미리 다음 말을 쓴다
  h.finish(ACCEPTED)
  expect(await sending).toBe(true)
  expect(useChat.getState().draft).toBe('다음 답 초안')
  expect(h.persisted.at(-1)).toBe('다음 답 초안')
})

test('② 전부 지웠다 같은 문장을 다시 쓴 경우에도 지우지 않는다', async () => {
  const h = harness()
  ;(globalThis as unknown as { window: unknown }).window = { knuaf: h.api }
  h.reset()
  useChat.getState().setDraft('네')
  const sending = useChat.getState().send()
  useChat.getState().setDraft('')                 // 지우고
  useChat.getState().setDraft('네')               // 같은 문장을 다시 쓴다 — 문자열로는 구분 못 한다
  h.finish(ACCEPTED)
  expect(await sending).toBe(true)
  expect(useChat.getState().draft).toBe('네')
  expect(h.persisted.at(-1)).toBe('네')
})

test('③ 보내는 동안 아무것도 안 썼으면 초안은 비워진다', async () => {
  const h = harness()
  ;(globalThis as unknown as { window: unknown }).window = { knuaf: h.api }
  h.reset()
  useChat.getState().setDraft('첫 답')
  const sending = useChat.getState().send()
  h.finish(ACCEPTED)
  expect(await sending).toBe(true)
  expect(useChat.getState().draft).toBe('')
  expect(h.persisted.at(-1)).toBe('')
})

test('④ 실패한 전송은 초안을 건드리지 않는다', async () => {
  const h = harness()
  ;(globalThis as unknown as { window: unknown }).window = { knuaf: h.api }
  h.reset()
  useChat.getState().setDraft('첫 답')
  const sending = useChat.getState().send()
  h.finish(REFUSED)
  expect(await sending).toBe(false)
  expect(useChat.getState().draft).toBe('첫 답')
  expect(useChat.getState().error).toContain('저장·검사')
})

test('⑤ 보기를 눌러 보낸 `send(text)` 는 초안을 건드리지 않는다', async () => {
  const h = harness()
  ;(globalThis as unknown as { window: unknown }).window = { knuaf: h.api }
  h.reset()
  useChat.getState().setDraft('내가 쓰던 말')
  const sending = useChat.getState().send('2) 온라인 직거래')
  h.finish(ACCEPTED)
  expect(await sending).toBe(true)
  expect(useChat.getState().draft).toBe('내가 쓰던 말')
  expect(h.persisted.at(-1)).toBe('내가 쓰던 말')
})
