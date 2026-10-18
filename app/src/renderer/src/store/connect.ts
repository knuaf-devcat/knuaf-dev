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

/** 로그인 왕복은 브라우저에서 오래 걸린다 — 3초마다, 3분까지. (useChat.login 이 쓰던 규칙) */
const POLL_MS = 3_000
const POLL_LIMIT_MS = 180_000

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

/** 폴링은 하나뿐이다(store 밖) — 두 공급자를 동시에 기다리지 않는다. */
let poll: ReturnType<typeof setInterval> | null = null
let pollDeadline = 0
function stopPoll(): void { if (poll) { clearInterval(poll); poll = null } }

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
    stopPoll()
    set((s) => ({ loggingIn: { ...s.loggingIn, [provider]: true } }))
    const r = await window.knuaf.connect.login(provider) as Reply<true>
    if ('error' in r) {
      set({ loggingIn: { ...get().loggingIn, [provider]: false } })
      set(one(provider, { state: 'failed', detail: r.error?.message ?? '', version: null }))
      return
    }
    pollDeadline = Date.now() + POLL_LIMIT_MS
    poll = setInterval(() => {
      void (async () => {
        await get().refresh(provider)
        const now = get()
        const done = displayState(now[provider], now.loggingIn[provider]) === 'connected'
        if (done || Date.now() > pollDeadline) { stopPoll(); set((s) => ({ loggingIn: { ...s.loggingIn, [provider]: false } })) }
      })()
    }, POLL_MS)
  },
  cancel: async (provider) => {
    stopPoll()
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
