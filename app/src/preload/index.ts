import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ChatSnapshot, Provider } from '../shared/chat'

type EventHandler = (event: string, data: unknown) => void
const handlers = new Map<string, EventHandler>()
let seq = 0

ipcRenderer.on('rpc:event', (_e, payload: { clientId: string; event: string; data: unknown }) => {
  handlers.get(payload.clientId)?.(payload.event, payload.data)
})

const api = {
  /** Platform of the main process (renderer has no Node). */
  platform: process.platform,
  /**
   * Call a sidecar method. `onEvent` receives progress/log events for this call only.
   * Pass your own `clientId` when you want to be able to `cancel(clientId)` while it runs.
   */
  call: async (method: string, params: Record<string, unknown> = {}, onEvent?: EventHandler, clientId?: string) => {
    const id = clientId ?? `c${++seq}`
    if (onEvent) handlers.set(id, onEvent)
    try { return await ipcRenderer.invoke('rpc', method, params, id) } finally { handlers.delete(id) }
  },
  /** Cancel the in-flight `call`/`depsEnsure` started with this clientId. Resolves true when something was running. */
  cancel: (clientId: string): Promise<boolean> => ipcRenderer.invoke('rpc:cancel', clientId),
  openProject: (root: string) => ipcRenderer.invoke('project:open', root),
  peekProject: (root: string) => ipcRenderer.invoke('project:peek', root),
  /** 이 작업폴더에서는 판정 불가한 명령도 묻지 않는다(설정에서 되돌릴 수 있다). */
  trustProject: (root: string, on: boolean) => ipcRenderer.invoke('project:trust', root, on),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('project:pick'),
  pickFile: (opts: { title?: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null> => ipcRenderer.invoke('file:pick', opts),
  reveal: (path: string) => ipcRenderer.invoke('shell:reveal', path),
  openPath: (path: string) => ipcRenderer.invoke('shell:open', path),
  /** Read a previewable file (.pdf/.md/.txt) inside the project root → { result: Uint8Array } | { error }. */
  fileRead: (root: string, relPath: string) => ipcRenderer.invoke('file:read', root, relPath),
  /** Existence check inside the project root → { result: boolean }. Unlike fileRead, any extension. */
  fileExists: (root: string, relPath: string): Promise<{ result: boolean } | { error: { code: string; message: string } }> => ipcRenderer.invoke('file:exists', root, relPath),
  /** Copy a file inside the project root to a user-chosen location → { result: savedPath | null } | { error }. */
  fileSaveAs: (root: string, relPath: string) => ipcRenderer.invoke('file:save-as', root, relPath),
  windowInfo: () => ipcRenderer.invoke('window:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch),
  sidecarInfo: () => ipcRenderer.invoke('sidecar:info'),
  sidecarRestart: () => ipcRenderer.invoke('sidecar:restart'),
  depsEnsure: async (root: string, onEvent?: EventHandler, clientId?: string) => {
    const id = clientId ?? `c${++seq}`
    if (onEvent) handlers.set(id, onEvent)
    try { return await ipcRenderer.invoke('deps:ensure', root, id) } finally { handlers.delete(id) }
  },
  onMenu: (fn: (action: { type: string; root?: string; screen?: string }) => void) => {
    const listener = (_e: unknown, action: { type: string; root?: string; screen?: string }) => fn(action)
    ipcRenderer.on('menu', listener)
    return () => ipcRenderer.removeListener('menu', listener)
  },
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  isDir: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:is-dir', p),
  agentStatus: (root: string | null) => ipcRenderer.invoke('agent:status', root),
  agentInstallSkill: (kind: 'claude' | 'codex', root: string | null) => ipcRenderer.invoke('agent:install-skill', kind, root),
  agentLaunch: (opts: { root: string; kind: 'claude' | 'codex'; revision: number | null }) => ipcRenderer.invoke('agent:launch', opts),
  /** Structured agent chat (Codex app-server). Every call resolves { result } or { error: {code,message} }. */
  chat: {
    snapshot: (root: string, provider: Provider) => ipcRenderer.invoke('chat:snapshot', root, provider),
    status: (root: string, provider: Provider) => ipcRenderer.invoke('chat:status', root, provider),
    login: (root: string, provider: Provider) => ipcRenderer.invoke('chat:login', root, provider),
    send: (root: string, provider: Provider, text: string, requestId: string) => ipcRenderer.invoke('chat:send', root, provider, text, requestId),
    respond: (root: string, provider: Provider, id: string, allow: boolean) => ipcRenderer.invoke('chat:respond', root, provider, id, allow),
    stop: (root: string, provider: Provider) => ipcRenderer.invoke('chat:stop', root, provider)
  },
  /** Snapshot push from the main ChatService; returns an unsubscribe function. */
  onChatSnapshot: (fn: (snapshot: ChatSnapshot) => void) => {
    const listener = (_e: unknown, snapshot: ChatSnapshot) => fn(snapshot)
    ipcRenderer.on('chat:snapshot', listener)
    return () => ipcRenderer.removeListener('chat:snapshot', listener)
  },
  openGuide: (): Promise<boolean> => ipcRenderer.invoke('guide:open'),
  appInfo: (): Promise<{ version: string; packaged: boolean; logs: string; userData: string; electron: string; node: string }> => ipcRenderer.invoke('app:info'),
  onSidecarLog: (fn: (entry: { stream: string; line: string }) => void) => {
    const listener = (_e: unknown, entry: { stream: string; line: string }) => fn(entry)
    ipcRenderer.on('sidecar:log', listener)
    return () => ipcRenderer.removeListener('sidecar:log', listener)
  }
}

contextBridge.exposeInMainWorld('knuaf', api)
export type KnuafApi = typeof api
