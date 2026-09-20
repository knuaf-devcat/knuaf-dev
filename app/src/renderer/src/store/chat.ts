import { create } from 'zustand'
import type { ChatSnapshot, ConnectionStatus, Provider } from '../../../shared/chat'

/** 어떤 도우미로 채팅하는지. 인앱 터미널 모드는 제거됐다 — 내 논문은 항상 앱 채팅이다. */
export type ChatMode = 'codex-chat' | 'claude-chat'

export function chatProvider(mode: ChatMode): Provider {
  return mode === 'claude-chat' ? 'claude' : 'codex'
}

/**
 * Effective mode: a session pick (`mode`) wins; then the persisted `helper_mode`.
 * main 의 loadSettings 가 옛 *-term 값을 채팅으로 옮겨 주지만, 디스크 값이 그대로
 * 도착하는 경우(마이그레이션 전 상태를 주입하는 테스트 등)를 위해 여기서도 한 번 더
 * 정규화한다 — term 은 공급자를 보존한 채 chat 으로.
 */
export function resolveChatMode(mode: ChatMode | null, settings: { helper_mode?: string | null } | null): ChatMode {
  if (mode) return mode
  const h = settings?.helper_mode
  if (h === 'claude-chat' || h === 'claude-term') return 'claude-chat'
  return 'codex-chat'
}

type Reply<T> = { result: T } | { error: { code: string; message: string } }

function messageOf(r: Reply<unknown>): string | null {
  return 'error' in r && r.error ? r.error.message : null
}

interface ChatState {
  root: string | null
  provider: Provider
  snapshot: ChatSnapshot | null
  status: ConnectionStatus | null
  /** status 호출 자체가 실패 — 확정된 실패지 "확인 중"이 아니다. 가짜 status를 만들지 않고 구분한다. */
  statusFailed: boolean
  draft: string
  busy: boolean
  error: string | null
  /** Session override; null = follow settings.helper_mode / codex_terminal. */
  mode: ChatMode | null
  setMode: (mode: ChatMode | null) => void
  setDraft: (draft: string) => void
  /** Append a picked/dropped file path to the draft as plain text — nothing else happens. */
  insertPath: (path: string) => void
  /**
   * Append a prepared request (e.g. 점검의 "고쳐달라기") to the draft, keeping whatever the
   * student was typing. Never replaces — same join rule as insertPath. Never sends: the send
   * button stays under the student's finger, and when the helper is busy the gate already
   * holds it.
   */
  appendDraft: (text: string) => void
  clearError: () => void
  load: (root: string, provider?: Provider) => Promise<void>
  refreshStatus: () => Promise<void>
  login: () => Promise<void>
  /** Send `text` (defaults to the draft) with a fresh requestId; clears the draft on acceptance. */
  send: (text?: string) => Promise<void>
  respond: (id: string, allow: boolean) => Promise<void>
  stop: () => Promise<void>
  /** Push target for window.knuaf.onChatSnapshot; ignores snapshots for other roots/providers. */
  onSnapshot: (snapshot: ChatSnapshot) => void
}

/** Login opens an external browser; poll status until the account connects (max 3 min). */
let loginPoll: ReturnType<typeof setInterval> | null = null

export const useChat = create<ChatState>((set, get) => ({
  root: null,
  provider: 'codex',
  snapshot: null,
  status: null,
  statusFailed: false,
  draft: '',
  busy: false,
  error: null,
  mode: null,
  setMode: (mode) => set({ mode, ...(mode ? { provider: chatProvider(mode) } : {}) }),
  setDraft: (draft) => set({ draft }),
  insertPath: (path) => set((s) => ({ draft: s.draft ? (s.draft.endsWith('\n') ? s.draft + path : s.draft + '\n' + path) : path })),
  appendDraft: (text) => get().insertPath(text),
  clearError: () => set({ error: null }),
  load: async (root, provider = get().provider) => {
    if (loginPoll) { clearInterval(loginPoll); loginPoll = null }
    set({ root, provider, snapshot: null, status: null, statusFailed: false, error: null })
    const [snap, st] = await Promise.all([
      window.knuaf.chat.snapshot(root, provider) as Promise<Reply<ChatSnapshot>>,
      window.knuaf.chat.status(root, provider) as Promise<Reply<ConnectionStatus>>
    ])
    if (get().root !== root || get().provider !== provider) return
    set({
      snapshot: 'result' in snap ? snap.result : null,
      status: 'result' in st ? st.result : null,
      statusFailed: !('result' in st),
      error: messageOf(snap) ?? messageOf(st)
    })
  },
  refreshStatus: async () => {
    const { root, provider } = get()
    if (!root) return
    const st = await window.knuaf.chat.status(root, provider) as Reply<ConnectionStatus>
    if (get().provider !== provider) return
    set({ status: 'result' in st ? st.result : get().status, statusFailed: !('result' in st), error: messageOf(st) })
  },
  login: async () => {
    const { root, provider } = get()
    if (!root) return
    if (loginPoll) { clearInterval(loginPoll); loginPoll = null }
    set({ busy: true, error: null })
    const r = await window.knuaf.chat.login(root, provider) as Reply<true>
    set({ busy: false, error: messageOf(r) })
    if ('error' in r && r.error) return
    // The browser login takes a while: re-check every 3 s for up to 3 minutes.
    const deadline = Date.now() + 180_000
    loginPoll = setInterval(() => {
      void (async () => {
        await get().refreshStatus()
        if (get().status?.connected || Date.now() > deadline) {
          if (loginPoll) { clearInterval(loginPoll); loginPoll = null }
        }
      })()
    }, 3000)
  },
  send: async (text) => {
    const { root, provider, draft } = get()
    const body = (text ?? draft).trim()
    if (!root || !body) return
    set({ busy: true, error: null })
    const requestId = crypto.randomUUID()
    const r = await window.knuaf.chat.send(root, provider, body, requestId) as Reply<ChatSnapshot>
    if ('result' in r) set({ busy: false, snapshot: r.result, draft: text === undefined ? '' : get().draft })
    else set({ busy: false, error: messageOf(r) })
  },
  respond: async (id, allow) => {
    const { root, provider } = get()
    if (!root) return
    const r = await window.knuaf.chat.respond(root, provider, id, allow) as Reply<true>
    set({ error: messageOf(r) })
  },
  stop: async () => {
    const { root, provider } = get()
    if (!root) return
    const r = await window.knuaf.chat.stop(root, provider) as Reply<true>
    set({ error: messageOf(r) })
  },
  onSnapshot: (snapshot) => {
    if (snapshot.root === get().root && snapshot.provider === get().provider) set({ snapshot })
  }
}))
