import { create } from 'zustand'
import type { ConnectionStatus, Provider } from '../../../shared/chat'

/**
 * 폴더 밖에서 보는 AI 연결 상태(IMPL-PLAN §4-3, R5 §6.3).
 *
 * 대화 상태(store/chat)에서 떼어 낸 이유: 연결은 CLI 전역 계정의 사실이라 논문 폴더와
 * 무관한데, 예전에는 상태 갱신·로그인이 root 에 묶여 있어 폴더를 고르기 전에는 아무것도
 * 확인할 수 없었다. 첫 실행은 이제 "AI 연결 → 논문 폴더" 순서다.
 *
 * 이름과 달리 상태 이름은 **관찰한 것만** 말한다 — 확인하지 못한 것을 연결됨이나
 * 끊김으로 꾸미지 않는다(`unknown`·`failed` 가 그 자리다).
 */
export type ConnState =
  | 'checking'   // 아직 물어보는 중
  | 'no-tool'    // 연결 도구가 이 컴퓨터에 없다
  | 'need-login' // 도구는 있는데 구독 로그인이 안 되어 있다
  | 'logging-in' // 브라우저에서 로그인하는 중
  | 'connected'  // 구독 계정 연결 확인
  | 'failed'     // 상태를 확인하지 못했다(실행 실패·시간 초과·오류)
  | 'unknown'    // 상태 확인 요청 자체가 실패했다

export interface ConnInfo { state: ConnState; detail: string; version: string | null }

const INITIAL: ConnInfo = { state: 'checking', detail: '', version: null }

/**
 * main 이 준 `ConnectionStatus` 를 화면 상태로 옮긴다. 순수 함수 — 단위 시험이 고정한다.
 * `probe`(확인 실패 구분)가 없으면 `'ok'` 로 읽는다: 기존 호출자와 같은 뜻이다.
 */
export function connInfoOf(status: ConnectionStatus): ConnInfo {
  const info = { detail: status.detail ?? '', version: status.version ?? null }
  if (!status.installed) return { ...info, state: 'no-tool' }
  if (status.probe === 'failed') return { ...info, state: 'failed' }
  if (status.connected) return { ...info, state: 'connected' }
  return { ...info, state: 'need-login' }
}

/**
 * 실제로 보여 줄 상태. 로그인 창을 띄워 둔 동안에는 확인이 "로그인 필요"를 돌려줘도
 * 그 표시를 유지한다 — 브라우저에서 로그인하는 학생에게 화면이 "로그인이 필요해요"로
 * 돌아가 있으면 무엇을 기다리는지 알 수 없다. 끝난 사실(연결됨·확인 실패·도구 없음)은
 * 기다림보다 세다.
 */
export function displayState(info: ConnInfo, loggingIn: boolean): ConnState {
  if (loggingIn && info.state !== 'connected' && info.state !== 'failed' && info.state !== 'no-tool') return 'logging-in'
  return info.state
}

type Reply<T> = { result: T } | { error: { code: string; message: string } }

/** 로그인 왕복은 브라우저에서 오래 걸린다 — 3초마다, 3분까지. */
const POLL_MS = 3_000
const POLL_LIMIT_MS = 180_000

/** 로그인 감시 타이머 핸들 — 런타임(DOM/Node)에 따라 모양이 달라 이름을 한 번만 붙인다. */
type PollTimer = ReturnType<typeof setInterval>

/**
 * 로그인을 지켜보는 폴링 — **공급자마다 하나**. 첫 화면(전역 연결)과 폴더 화면
 * (`useChat.login`)이 같은 규칙을 쓴다 — 두 곳에 타이머를 두면 한쪽만 바뀐다
 * (설계 §4-3: "폴링은 이리로 옮긴다").
 *
 * 공급자별인 이유(W2 D1): 예전에는 전역 타이머 하나여서 Claude 로그인을 시작하는 순간
 * GPT 로그인 감시가 사라졌다. 실제로는 GPT 가 연결됐는데도 화면은 "로그인 중"에 멈췄다.
 * 한 공급자의 시작·취소는 다른 공급자의 타이머를 건드리지 않는다.
 *
 * `tick` 이 true 를 돌려주면(연결됨) 멈춘다. 폴더를 바꾸거나 화면을 떠나면 `stopPoll()` —
 * 인자 없이 부르면 전부 멈춘다.
 */
const polls = new Map<Provider, PollTimer>()
export function stopPoll(provider?: Provider): void {
  if (provider) {
    const timer = polls.get(provider)
    if (timer) { clearInterval(timer); polls.delete(provider) }
    return
  }
  for (const timer of polls.values()) clearInterval(timer)
  polls.clear()
}
export function startPoll(provider: Provider, tick: () => Promise<boolean>): void {
  stopPoll(provider)
  const deadline = Date.now() + POLL_LIMIT_MS
  const timer = setInterval(() => {
    void (async () => {
      const done = await tick()
      // 기다리는 사이 새 시도가 이 타이머를 갈아 끼웠으면 이 응답은 지금 것의 것이 아니다.
      if (polls.get(provider) !== timer) return
      if (done || Date.now() > deadline) stopPoll(provider)
    })()
  }, POLL_MS)
  polls.set(provider, timer)
}

/**
 * 로그인 시도 번호 — **공급자마다**. 취소·새 시도가 그 공급자의 번호를 올리면, **이미 진행
 * 중이던** 그 공급자의 로그인 IPC 늦은 응답은 무효다(P2-R1-04). 취소는 그 순간 살아 있는
 * 타이머만 없앨 수 있어서, 응답이 뒤늦게 도착해 폴링을 다시 만들면 취소가 화면에서만 일어난
 * 것처럼 보인다 — Codex 의 로그인 응답은 브라우저 열기까지 기다리므로 이 순서가 실제로 난다.
 *
 * 공급자별인 이유(W2 D1): 전역 번호 하나였을 때는 Claude 로그인을 시작하는 것만으로
 * GPT 의 유효한 로그인 응답이 무효 처리돼, GPT 가 실제로 연결됐는데도 `loggingIn` 이
 * true 인 채 남았다.
 */
const attempts = new Map<Provider, number>()

/**
 * 지금 대화할 공급자 — 학생이 고른 것(`provider_choice`, 세션에서 고른 것)이 먼저다.
 * 고른 적이 없으면 null 이고, 화면은 옛 기본값(`helper_mode`)으로 되돌아간다.
 */
export function chosenProvider(selected: Provider | null, settings: { provider_choice?: { provider: Provider } | null } | null): Provider | null {
  return selected ?? settings?.provider_choice?.provider ?? null
}

/**
 * 첫 실행 1단계를 지날 수 있는가 — **고른 것이 지금 연결돼 있어야** 한다(P2-R1-03).
 * 저장된 선택만 보고 넘어가면 연결을 못 마친 첫 실행이 "AI 연결 완료"로 보인다.
 * [다음] 단추, 자동 건너뛰기, 2단계의 `AI 연결 ✓` 가 모두 이 한 함수를 쓴다.
 */
export function canAdvance(selected: Provider | null, state: (provider: Provider) => ConnState): boolean {
  return selected !== null && state(selected) === 'connected'
}

interface ConnectState {
  codex: ConnInfo
  claude: ConnInfo
  /** 학생이 고른 공급자. 온보딩 1단계·설정 라디오가 기록한다. */
  selected: Provider | null
  /** 로그인 창을 띄워 둔 공급자 — displayState 가 이 값을 쓴다. */
  loggingIn: Record<Provider, boolean>
  select: (provider: Provider | null) => void
  /** 한 공급자의 상태를 지금 다시 묻는다. */
  refresh: (provider: Provider) => Promise<void>
  /** 둘 다(온보딩 1단계 진입). */
  refreshAll: () => Promise<void>
  login: (provider: Provider) => Promise<void>
  cancel: (provider: Provider) => Promise<void>
  reopen: (provider: Provider) => Promise<void>
  /** 폴링을 멈춘다 — 첫 화면을 떠날 때 부른다. */
  stopPolling: () => void
}

/** 계산된 키로 한 공급자만 갈아 끼우는 patch — zustand 의 set 에 넘긴다. */
function one(provider: Provider, info: ConnInfo): Partial<ConnectState> {
  return provider === 'codex' ? { codex: info } : { claude: info }
}

export const useConnect = create<ConnectState>((set, get) => ({
  codex: INITIAL,
  claude: INITIAL,
  selected: null,
  loggingIn: { codex: false, claude: false },
  select: (selected) => set({ selected }),
  refresh: async (provider) => {
    const r = await window.knuaf.connect.status(provider) as Reply<ConnectionStatus>
    if (!('result' in r)) {
      set(one(provider, { state: 'unknown', detail: r.error?.message ?? '', version: null }))
      return
    }
    set(one(provider, connInfoOf(r.result)))
  },
  refreshAll: async () => { await Promise.all([get().refresh('codex'), get().refresh('claude')]) },
  login: async (provider) => {
    // 시도 번호와 타이머는 **그 공급자 것만** 건드린다(W2 D1) — 다른 쪽 로그인을 시작해도
    // 진행 중이던 로그인의 응답이 무효가 되거나 그 감시가 사라지지 않는다.
    const mine = (attempts.get(provider) ?? 0) + 1
    attempts.set(provider, mine)
    stopPoll(provider)
    set((s) => ({ loggingIn: { ...s.loggingIn, [provider]: true } }))
    const r = await window.knuaf.connect.login(provider) as Reply<true>
    // 그 사이에 이 공급자를 취소했거나 새 시도가 시작됐으면 이 응답은 지금 화면의 것이 아니다 —
    // 상태를 바꾸지도, 폴링을 다시 만들지도 않는다(P2-R1-04).
    if (mine !== (attempts.get(provider) ?? 0)) return
    if ('error' in r) {
      set({ loggingIn: { ...get().loggingIn, [provider]: false } })
      set(one(provider, { state: 'failed', detail: r.error?.message ?? '', version: null }))
      return
    }
    // 로그인이 끝나면 기다림 표시도 내린다.
    startPoll(provider, async () => {
      await get().refresh(provider)
      const done = displayState(get()[provider], get().loggingIn[provider]) === 'connected'
      if (done) set((s) => ({ loggingIn: { ...s.loggingIn, [provider]: false } }))
      return done
    })
  },
  cancel: async (provider) => {
    attempts.set(provider, (attempts.get(provider) ?? 0) + 1)   // 이 공급자의 진행 중 로그인 응답을 무효로 만든다
    stopPoll(provider)
    set((s) => ({ loggingIn: { ...s.loggingIn, [provider]: false } }))
    await window.knuaf.connect.cancel(provider)
    // 취소 뒤의 사실은 다시 물어서 말한다 — "취소했어요"를 상태로 단정하지 않는다.
    await get().refresh(provider)
  },
  reopen: async (provider) => {
    const r = await window.knuaf.connect.reopen(provider) as Reply<true>
    if ('error' in r) set((s) => ({ loggingIn: { ...s.loggingIn, [provider]: false } }))
  },
  stopPolling: () => stopPoll()
}))
