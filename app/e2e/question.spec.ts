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

function snap(messages: ChatMessage[], state: ChatSnapshot['state'] = 'idle', root = '/p'): ChatSnapshot {
  return { root, provider: 'codex', state, messages }
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

test('보기 묶음 뒤에 보기 모양 줄이 더 있으면 카드가 아니다 (검토 P1-R1-02)', () => {
  // 빈 줄 뒤에 3)·4) 가 이어지면 앞쪽 2개만 잘라 카드로 만들면 안 된다 — 보기 사이 빈 줄은
  // 건너뛰고 끝까지 읽는다(형님 윈도우 실기 2026-10-19 이후). 잘리지 않고 4개 모두 나와야 한다.
  expect(parseQuestion('[Q1-1] 판매처\n어디에 파나요?\n1) 농협\n2) 온라인\n\n3) 직매장\n4) 아직 몰라요\n')?.options).toEqual(['농협', '온라인', '직매장', '아직 몰라요'])
  // 설명 줄을 끼우고 3) 을 놓아도 같다.
  expect(parseQuestion('[Q1-1] 판매처\n어디에 파나요?\n1) 농협\n2) 온라인\n(추천) 가까운 곳\n3) 직매장\n')).toBeNull()
  // `→ …` 안내 줄·빈 줄은 보기가 아니다 — 정상 원문은 그대로 읽힌다.
  expect(parseQuestion(Q())?.options).toHaveLength(3)
  expect(parseQuestion('[Q1-1] 판매처\n어디에 파나요?\n1) 농협\n2) 온라인\n\n→ 번호 또는 자유 입력\n')?.options).toEqual(['농협', '온라인'])
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
  // 카드 판정은 이 수를 보지 않는다(REPORT-WIN-FEEDBACK §2) — 세는 규칙만 여기서 고정한다.
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
  // 이미 답한 질문(그 뒤에 학생 메시지가 있음)은 카드가 아니다 — 정본 tasks 와 무관하다.
  const answered = [msg({ role: 'assistant', text: Q() }), msg({ role: 'user', text: '2) 온라인 직거래', delivery: 'sent' })]
  expect(zoneOf(snap(answered), CONNECTED, status({ tasks: [] })).kind).toBe('composer')
})

test('정본에 기다리는 질문이 없어도 답하지 않은 질문이면 카드다 (형님 윈도우 실기 2026-10-19)', () => {
  // 새 논문의 실제 상태 — tasks 에는 한글 마무리뿐이다(gg_core.next_tasks 실측). 예전에는 이 상태에서
  // 카드가 한 번도 뜨지 않았다.
  const fresh = status({ tasks: [{ id: 'font_shinmyeongjo', status: 'needs_user' }], user_finish_pending: [{ id: 'font_shinmyeongjo', status: 'needs_user', owner: 'user', reason: '글꼴' }] })
  expect(waitingQuestionCount(fresh)).toBe(0)
  expect(zoneOf(snap([msg({ role: 'assistant', text: Q() })]), CONNECTED, fresh).kind).toBe('question')
  expect(zoneOf(snap([msg({ role: 'assistant', text: Q() })]), CONNECTED, null).kind).toBe('question')
})

test('도우미가 형식을 조금 벗어나도 같은 질문이면 읽는다 (형님 윈도우 실기 2026-10-19)', () => {
  const canonical = parseQuestion(Q())!
  const variants: Record<string, string> = {
    '굵은 글씨': Q().replace('[Q3-2] Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요', '**[Q3-2] Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요**').replace(/  (\d)\) /g, '  **$1)** '),
    '윈도우 줄바꿈': Q().replace(/\n/g, '\r\n'),
    '전각 괄호': Q().replace(/  (\d)\) /g, '  $1） ').replace('[Q3-2]', '［Q3-2］'),
    '목록 표시': Q().replace(/  (\d)\) /g, '  - $1) '),
    '보기 사이 빈 줄': Q().replace(/\n(  [23]\) )/g, '\n\n$1')
  }
  for (const [name, text] of Object.entries(variants)) {
    const got = parseQuestion(text)
    expect(got?.options, name).toEqual(canonical.options)
    expect(got?.id, name).toBe('Q3-2')
  }
  // 넓히지 않는 것: 스킬의 `[Q2] 기본 계획` 은 네 칸을 한꺼번에 답하는 질문이다 — 고르는 카드가
  // 되면 틀린 카드다. `[Qn]` 머리와 `1.` 번호는 그래서 읽지 않는다.
  expect(parseQuestion('[Q2] 기본 계획\n1. 전공\n2. 작목\n3. 지역\n4. 자금\n')).toBeNull()
  expect(parseQuestion('[Q2] 기본 계획\n1) 전공\n2) 작목\n')).toBeNull()
  expect(parseQuestion(Q().replace(/  (\d)\) /g, '  $1. '))).toBeNull()
  // 보기 사이에 다른 글(예시 줄)이 끼면 여전히 카드가 아니다 — 틀린 카드보다 카드 없음.
  expect(parseQuestion('[Q2-1] 기본 계획\n1) 전공\n   예: 스마트팜\n2) 작목\n')).toBeNull()
})

test('번호 괄호 안에 꼬리말이 붙은 머리도 읽는다 — `[Q2-4 도움]` (형님 맥 실사용 2026-10-20 ②)', () => {
  // 형님 맥 대화(`GUI Test/.knuaf-gui/chat-codex.json`)의 마지막 도우미 메시지(설명 줄은 줄였다).
  const real = [
    '우선 새싹삼과 도라지 두 후보를 비교해볼 수 있습니다.',
    '',
    '1. 새싹삼 — 시설재배  ',
    '   1년생 묘삼을 심어 약 3~4주 키우는 방식입니다.',
    '',
    '2. 도라지 — 노지재배  ',
    '   식용은 보통 파종 2년 차부터 수확합니다.',
    '',
    '제 추천은 새싹삼의 소규모 시험재배를 먼저 검토하는 쪽입니다.',
    '',
    '[Q2-4 도움] 어느 방향을 더 알아보고 싶나요?',
    '',
    '1) 새싹삼 시설재배',
    '2) 도라지 노지재배',
    '3) 아직 미정 — 작목 선택을 보류하고 부지·운영 조건부터 정리',
    '',
    '번호 또는 다른 관심 작목으로 답해 주세요.'
  ].join('\n')
  const got = parseQuestion(real)
  expect(got?.id).toBe('Q2-4')
  expect(got?.text).toBe('어느 방향을 더 알아보고 싶나요?')
  expect(got?.options).toEqual(['새싹삼 시설재배', '도라지 노지재배', '아직 미정 — 작목 선택을 보류하고 부지·운영 조건부터 정리'])
  // 질문이 머리 줄에 있으면 위 작은 줄에 같은 문장을 두 번 쓰지 않는다 — 괄호 안 꼬리말을 쓴다.
  expect(got?.use).toBe('도움')
  // 대화 칸에서는 보기 줄만 접힌다 — 질문 문장이 들어 있는 머리 줄은 남는다.
  const lines = real.split('\n')
  expect(lines[got!.span.start]).toBe('1) 새싹삼 시설재배')
  // 카드 조건까지: 이 메시지가 마지막이고 대화가 idle 이면 질문 카드 자리다.
  expect(zoneOf(snap([msg({ role: 'user', text: '미정' }), msg({ role: 'assistant', text: real })]), CONNECTED, null).kind).toBe('question')
  // 꼬리말 없는 머리는 그대로다.
  expect(parseQuestion(Q())?.use).toBe('Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요')
  // 넓히지 않는 것은 그대로: 하위 번호 없는 `[Q2 …]` 는 카드가 아니다.
  expect(parseQuestion('[Q2 기본] 계획\n1) 전공\n2) 작목\n')).toBeNull()
})

// --------------------------------------------------------------- draftAfterSend

test('초안 판정은 편집 번호로 한다 — 같은 문장을 지웠다 다시 써도 구분된다', () => {
  expect(draftAfterSend(3, 3, '첫 답')).toBe('')          // 안 바뀜 → 비운다
  expect(draftAfterSend(3, 4, '다음 답')).toBe('다음 답')   // 바뀜 → 그대로 둔다
  expect(draftAfterSend(3, 5, '네')).toBe('네')             // 지웠다 다시 쓴 경우(문자열로는 같다)
})

// --------------------------------------------------------------- send() 경합

const ROOT = '/p/race'

function harness(drafts: Record<string, string> = {}) {
  const persisted: string[] = []
  const writes: { root: string; text: string }[] = []
  const disk: Record<string, string> = { ...drafts }
  let pending: ((value: unknown) => void) | null = null
  const api = {
    chat: {
      snapshot: async (root: string) => ({ result: snap([], 'idle', root) }),
      status: async () => ({ result: CONNECTED }),
      draft: async (root: string) => ({ result: disk[root] ?? '' }),
      setDraft: async (root: string, text: string) => { disk[root] = text; persisted.push(text); writes.push({ root, text }); return { result: true } },
      send: () => new Promise((resolve) => { pending = resolve as (v: unknown) => void }),
      login: async () => ({ result: true }),
      respond: async () => ({ result: true }),
      stop: async () => ({ result: true })
    }
  }
  return {
    api,
    persisted,
    writes,
    disk,
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

test('⑥ 응답을 기다리는 동안 다른 폴더를 열면 그 폴더의 화면·초안을 건드리지 않는다 (검토 P1-R1-01)', async () => {
  // 저장할 초안의 소유 폴더는 늘 `setDraft` 에 넘기는 root 여야 한다. 전에는 B 를 연 뒤
  // A 의 늦은 성공 응답이 B 의 미전송 초안을 읽어 **A 파일에** 저장했다.
  const h = harness({ '/A': '', '/B': 'B의 미전송 초안' })
  ;(globalThis as unknown as { window: unknown }).window = { knuaf: h.api }
  useChat.setState({
    root: null, provider: 'codex', snapshot: null, status: null, statusFailed: false,
    draft: '', draftSeq: 0, busy: false, error: null, mode: null
  })

  await useChat.getState().load('/A')
  useChat.getState().setDraft('A의 답변')
  const sending = useChat.getState().send()        // A 의 전송 응답을 보류한다

  await useChat.getState().load('/B')              // 그 사이 학생이 B 를 연다
  expect(useChat.getState().draft).toBe('B의 미전송 초안')

  h.finish({ result: snap([msg({ role: 'user', text: 'A의 답변', delivery: 'sent' })], 'running', '/A') })
  expect(await sending).toBe(true)

  // B 화면은 B 그대로다 — A 의 답변이 넘어오지 않는다.
  expect(useChat.getState().root).toBe('/B')
  expect(useChat.getState().snapshot?.root).toBe('/B')
  expect(useChat.getState().snapshot?.messages).toHaveLength(0)
  expect(useChat.getState().draft).toBe('B의 미전송 초안')
  expect(useChat.getState().busy).toBe(false)
  // A 의 파일에 B 의 내용이 쓰이지 않았다.
  expect(h.writes.filter((w) => w.root === '/A' && w.text === 'B의 미전송 초안')).toHaveLength(0)
  expect(h.disk['/A']).toBe('A의 답변')
})
