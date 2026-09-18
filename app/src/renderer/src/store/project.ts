import { create } from 'zustand'
import type { Settings, SidecarInfo, Status } from '../../../shared/types'
import { describeError, rpc, RpcFailure } from '../rpc'

export type Screen = 'home' | 'dashboard' | 'checks' | 'tasks' | 'sections' | 'outputs' | 'troubleshoot' | 'settings'

interface ProjectState {
  root: string | null
  hasProject: boolean
  status: Status | null
  loading: boolean
  error: string | null
  sidecar: (SidecarInfo & { basePython?: string; wheelhouse?: string | null }) | null
  settings: Settings | null
  screen: Screen
  logs: { stream: string; line: string }[]
  setScreen: (s: Screen) => void
  loadSettings: () => Promise<void>
  open: (root: string) => Promise<void>
  refresh: () => Promise<void>
  refreshSidecar: () => Promise<void>
  pushLog: (entry: { stream: string; line: string }) => void
  clearLogs: () => void
}

export const useProject = create<ProjectState>((set, get) => ({
  root: null,
  hasProject: false,
  status: null,
  loading: false,
  error: null,
  sidecar: null,
  settings: null,
  screen: 'home',
  logs: [],
  setScreen: (screen) => { set({ screen }); location.hash = screen },
  loadSettings: async () => set({ settings: await window.knuaf.getSettings() }),
  open: async (root) => {
    set({ loading: true, error: null })
    const r = await window.knuaf.openProject(root)
    if (r.error) { set({ loading: false, error: describeError(new RpcFailure(r.error)) }); return }
    set({ root, hasProject: r.result.hasProject, sidecar: r.result.sidecar, status: null })
    await get().loadSettings()
    if (r.result.hasProject) await get().refresh()
    else set({ loading: false })
    get().setScreen(r.result.hasProject ? 'dashboard' : 'troubleshoot')
  },
  refresh: async () => {
    const root = get().root
    if (!root) return
    set({ loading: true, error: null })
    try {
      const status = await rpc.status(root)
      set({ status, hasProject: true, loading: false })
    } catch (e) {
      set({ error: describeError(e), loading: false })
    }
  },
  refreshSidecar: async () => set({ sidecar: await window.knuaf.sidecarInfo() }),
  pushLog: (entry) => set((s) => ({ logs: [...s.logs.slice(-499), entry] })),
  clearLogs: () => set({ logs: [] })
}))
