import { create } from 'zustand'
import type { ProjectPeek, Settings, SidecarInfo, Status } from '../../../shared/types'
import { CHAT, describeError, type DescribedError } from '../copy'
import { rpc } from '../rpc'
import { useChat } from './chat'

export type Screen = 'chat' | 'materials' | 'artifacts' | 'checkup' | 'settings'

/**
 * 설정 화면 안에서 펼침을 열 대상 — 'tools:excel' 같은 프리셋. 실패 피드백의
 * "고급 도구에서 직접 실행"이 여기로 간다(Q2: "설정으로 가세요"가 아니라 해당 항목 직결).
 */
export type SettingsFocus = string | null

interface ProjectState {
  root: string | null
  hasProject: boolean
  status: Status | null
  peek: ProjectPeek | null
  depsReady: boolean | null
  loading: boolean
  error: DescribedError | null
  sidecar: (SidecarInfo & { basePython?: string; wheelhouse?: string | null }) | null
  settings: Settings | null
  screen: Screen
  settingsFocus: SettingsFocus
  logs: { stream: string; line: string }[]
  setScreen: (s: Screen) => void
  /** Navigate to 설정 with a disclosure preset open (deep link from failure feedback). */
  openSettings: (focus?: SettingsFocus) => void
  clearSettingsFocus: () => void
  loadSettings: () => Promise<void>
  /**
   * `local: true` — 실패를 전역 error 대신 반환값으로 돌려준다. 경로를 입력한 화면이
   * 제자리에서 알리게 하기 위함(GUI-04): 전역 error 는 Chat/Checkup 도 그리므로
   * 둘 다 세면 같은 오류가 두 화면에 뜬다.
   */
  open: (root: string, opts?: { local?: boolean }) => Promise<DescribedError | null>
  refresh: () => Promise<void>
  refreshSidecar: () => Promise<void>
  refreshDeps: () => Promise<void>
  prepareDeps: (root: string) => Promise<void>
  clearError: () => void
  helper: { open: boolean; status: any | null; result: { title: string; body?: string } | null; error: DescribedError | null }
  openHelper: () => Promise<void>
  launchHelper: (kind: 'claude' | 'codex') => Promise<void>
  closeHelper: () => void
  pushLog: (entry: { stream: string; line: string }) => void
  clearLogs: () => void
}

export const useProject = create<ProjectState>((set, get) => ({
  root: null,
  hasProject: false,
  status: null,
  peek: null,
  depsReady: null,
  loading: false,
  error: null,
  sidecar: null,
  settings: null,
  screen: 'chat',
  settingsFocus: null,
  logs: [],
  setScreen: (screen) => { set({ screen, ...(screen === 'settings' ? {} : { settingsFocus: null }) }); location.hash = screen },
  openSettings: (focus = null) => { set({ screen: 'settings', settingsFocus: focus }); location.hash = 'settings' },
  clearSettingsFocus: () => set({ settingsFocus: null }),
  loadSettings: async () => set({ settings: await window.knuaf.getSettings() }),
  open: async (root, opts) => {
    set({ loading: true, error: null })
    const r = await window.knuaf.openProject(root)
    if (r.error) {
      const d = describeError(r.error)
      if (!opts?.local) set({ error: d })
      set({ loading: false })
      return d
    }
    const peek = await window.knuaf.peekProject(root)
    set({ root, hasProject: r.result.hasProject, sidecar: r.result.sidecar, status: null, peek, depsReady: null })
    // 도우미가 하위 폴더에 init한 경우 — 빈 화면으로 두지 않고 어디에 만들었는지 알린다.
    const nested = (r.result as { nestedProject?: string | null }).nestedProject
    if (nested) set({ error: { kind: 'warning', title: '도우미가 다른 폴더에 논문을 만들었어요.', action: `"${nested}" 폴더 안에 논문 데이터가 있어요. 그 폴더를 열거나, 이 폴더가 맞으면 도우미에게 이 폴더에서 작업하라고 알려 주세요.`, code: 'nested_project', raw: `${nested}/project.json` } })
    await get().loadSettings()
    if (r.result.hasProject) await get().refresh(); else set({ loading: false })
    // 준비는 폴더를 여는 순간 백그라운드로 시작하고 실패만 표면화한다(03-화면/01 결정).
    // 옮겨 온 폴더도 deps가 비어 있을 수 있으니 매번 확인한다 — 준비됐으면 아무 일도 없다.
    void get().prepareDeps(root)
    void useChat.getState().load(root)
    get().setScreen('chat')
    return null
  },
  /** Quiet deps.ensure after refreshDeps reports not-ready; only a failure is surfaced. */
  prepareDeps: async (root) => {
    await get().refreshDeps()
    if (get().root !== root || get().depsReady !== false) return
    type DepsReply = { result?: { ok?: boolean; block_reason?: string | null; stderr?: string }; error?: { code?: string; message?: string } }
    const r: DepsReply = await window.knuaf.depsEnsure(root).catch((e: unknown) => ({ error: { message: String(e) } }))
    if (get().root !== root) return
    if ('result' in r && r.result?.ok) { void get().refreshDeps(); return }
    // 터미널 도우미가 작업 중이면 sidecar가 쓰기를 거절한다 — 실패가 아니라 바쁨이니 조용히 넘긴다.
    if ('error' in r && r.error?.code === 'agent_busy') return
    const detail = 'result' in r
      ? (r.result?.block_reason ?? r.result?.stderr?.trim().split('\n').filter(Boolean).at(-1) ?? 'deps.ensure failed')
      : String(r.error?.message ?? 'deps.ensure failed')
    set({ error: { kind: 'warning', title: CHAT.prepFailedTitle, action: '"설정 > 문제 해결"의 "준비 상태"를 확인해 주세요.', code: 'deps_ensure', raw: detail } })
  },
  refresh: async () => {
    const root = get().root
    if (!root) return
    set({ loading: true, error: null })
    try {
      const status = await rpc.status(root)
      const peek = await window.knuaf.peekProject(root)
      set({ status, peek, hasProject: true, loading: false })
    } catch (e) {
      set({ error: describeError(e), loading: false })
    }
  },
  refreshSidecar: async () => set({ sidecar: await window.knuaf.sidecarInfo() }),
  refreshDeps: async () => {
    const root = get().root
    if (!root) return
    try { const d = await rpc.doctor(root); set({ depsReady: !!d.deps?.ready }) } catch { set({ depsReady: null }) }
  },
  clearError: () => set({ error: null }),
  helper: { open: false, status: null, result: null, error: null },
  openHelper: async () => {
    set({ helper: { open: true, status: null, result: null, error: null } })
    const r = await window.knuaf.agentStatus(get().root)
    if (r.error) { set((s) => ({ helper: { ...s.helper, error: describeError(r.error) } })); return }
    set((s) => ({ helper: { ...s.helper, status: r.result } }))
    const st = r.result
    if (st.claude.found && !st.codex.found) await get().launchHelper('claude')
    else if (!st.claude.found && st.codex.found) await get().launchHelper('codex')
  },
  launchHelper: async (kind) => {
    const { root, status, peek } = get()
    if (!root) { set((s) => ({ helper: { ...s.helper, error: describeError({ code: 'not_found', message: '먼저 폴더를 열어 주세요' }) } })); return }
    const r = await window.knuaf.agentLaunch({ root, kind, revision: status?.revision ?? peek?.revision ?? null })
    if (r.error) { set((s) => ({ helper: { ...s.helper, error: describeError(r.error) } })); return }
    set((s) => ({ helper: { ...s.helper, result: { title: '터미널 창에서 AI 도우미가 열렸어요', body: undefined } } }))
  },
  closeHelper: () => set((s) => ({ helper: { ...s.helper, open: false } })),
  pushLog: (entry) => set((s) => ({ logs: [...s.logs.slice(-499), entry] })),
  clearLogs: () => set({ logs: [] })
}))
