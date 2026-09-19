import { create } from 'zustand'
import type { ProjectPeek, Settings, SidecarInfo, Status } from '../../../shared/types'
import { describeError, type DescribedError } from '../copy'
import { rpc } from '../rpc'
import { useChat } from './chat'

export type Screen = 'home' | 'chat' | 'materials' | 'artifacts' | 'dashboard' | 'checks' | 'tasks' | 'sections' | 'outputs' | 'troubleshoot' | 'settings'

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
  checksPreset: { owner?: string; prefix?: string } | null
  logs: { stream: string; line: string }[]
  setScreen: (s: Screen, preset?: { owner?: string; prefix?: string } | null) => void
  loadSettings: () => Promise<void>
  open: (root: string) => Promise<void>
  refresh: () => Promise<void>
  refreshSidecar: () => Promise<void>
  refreshDeps: () => Promise<void>
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
  screen: 'home',
  checksPreset: null,
  logs: [],
  setScreen: (screen, preset = null) => { set({ screen, checksPreset: preset }); location.hash = screen },
  loadSettings: async () => set({ settings: await window.knuaf.getSettings() }),
  open: async (root) => {
    set({ loading: true, error: null })
    const r = await window.knuaf.openProject(root)
    if (r.error) { set({ loading: false, error: describeError(r.error) }); return }
    const peek = await window.knuaf.peekProject(root)
    set({ root, hasProject: r.result.hasProject, sidecar: r.result.sidecar, status: null, peek, depsReady: null })
    await get().loadSettings()
    if (r.result.hasProject) await get().refresh(); else set({ loading: false })
    if (!r.result.hasProject || (peek.revision ?? 0) < 1) void get().refreshDeps()
    void useChat.getState().load(root)
    get().setScreen(r.result.hasProject ? 'chat' : 'home')
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
