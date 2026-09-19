import { create } from 'zustand'
import type { ChatSnapshot, ConnectionStatus, Provider } from '../../../shared/chat'

/** Students only ever see the Codex chat; the Claude SDK path stays behind KNUAF_CLAUDE_SDK in main. */
export const CHAT_PROVIDER: Provider = 'codex'

type Reply<T> = { result: T } | { error: { code: string; message: string } }

function messageOf(r: Reply<unknown>): string | null {
  return 'error' in r && r.error ? r.error.message : null
}

/** Which helper view the 내 논문 screen shows. 'codex-term' is used when Settings prefers the terminal. */
export type ChatMode = 'codex-chat' | 'claude-term' | 'codex-term'

interface ChatState {
  root: string | null
  snapshot: ChatSnapshot | null
  status: ConnectionStatus | null
  draft: string
  busy: boolean
  error: string | null
  mode: ChatMode
  setMode: (mode: ChatMode) => void
  setDraft: (draft: string) => void
  /** Append a picked/dropped file path to the draft as plain text — nothing else happens. */
  insertPath: (path: string) => void
  clearError: () => void
  load: (root: string) => Promise<void>
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
  snapshot: null,
  status: null,
  draft: '',
  busy: false,
  error: null,
  mode: 'codex-chat',
  setMode: (mode) => set({ mode }),
  setDraft: (draft) => set({ draft }),
  insertPath: (path) => set((s) => ({ draft: s.draft ? (s.draft.endsWith('\n') ? s.draft + path : s.draft + '\n' + path) : path })),
  clearError: () => set({ error: null }),
  load: async (root) => {
    if (loginPoll) { clearInterval(loginPoll); loginPoll = null }
    set({ root, snapshot: null, status: null, error: null })
    const [snap, st] = await Promise.all([
      window.knuaf.chat.snapshot(root, CHAT_PROVIDER) as Promise<Reply<ChatSnapshot>>,
      window.knuaf.chat.status(root, CHAT_PROVIDER) as Promise<Reply<ConnectionStatus>>
    ])
    if (get().root !== root) return
    set({
      snapshot: 'result' in snap ? snap.result : null,
      status: 'result' in st ? st.result : null,
      error: messageOf(snap) ?? messageOf(st)
    })
  },
  refreshStatus: async () => {
    const root = get().root
    if (!root) return
    const st = await window.knuaf.chat.status(root, CHAT_PROVIDER) as Reply<ConnectionStatus>
    set({ status: 'result' in st ? st.result : get().status, error: messageOf(st) })
  },
  login: async () => {
    const root = get().root
    if (!root) return
    if (loginPoll) { clearInterval(loginPoll); loginPoll = null }
    set({ busy: true, error: null })
    const r = await window.knuaf.chat.login(root, CHAT_PROVIDER) as Reply<true>
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
    const { root, draft } = get()
    const body = (text ?? draft).trim()
    if (!root || !body) return
    set({ busy: true, error: null })
    const requestId = crypto.randomUUID()
    const r = await window.knuaf.chat.send(root, CHAT_PROVIDER, body, requestId) as Reply<ChatSnapshot>
    if ('result' in r) set({ busy: false, snapshot: r.result, draft: text === undefined ? '' : get().draft })
    else set({ busy: false, error: messageOf(r) })
  },
  respond: async (id, allow) => {
    const root = get().root
    if (!root) return
    const r = await window.knuaf.chat.respond(root, CHAT_PROVIDER, id, allow) as Reply<true>
    set({ error: messageOf(r) })
  },
  stop: async () => {
    const root = get().root
    if (!root) return
    const r = await window.knuaf.chat.stop(root, CHAT_PROVIDER) as Reply<true>
    set({ error: messageOf(r) })
  },
  onSnapshot: (snapshot) => {
    if (snapshot.root === get().root && snapshot.provider === CHAT_PROVIDER) set({ snapshot })
  }
}))
