import { contextBridge, ipcRenderer } from 'electron'

type EventHandler = (event: string, data: unknown) => void
const handlers = new Map<string, EventHandler>()
let seq = 0

ipcRenderer.on('rpc:event', (_e, payload: { clientId: string; event: string; data: unknown }) => {
  handlers.get(payload.clientId)?.(payload.event, payload.data)
})

const api = {
  /** Call a sidecar method. `onEvent` receives progress/log events for this call only. */
  call: async (method: string, params: Record<string, unknown> = {}, onEvent?: EventHandler) => {
    const clientId = `c${++seq}`
    if (onEvent) handlers.set(clientId, onEvent)
    try { return await ipcRenderer.invoke('rpc', method, params, clientId) } finally { handlers.delete(clientId) }
  },
  openProject: (root: string) => ipcRenderer.invoke('project:open', root),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('project:pick'),
  pickFile: (opts: { title?: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null> => ipcRenderer.invoke('file:pick', opts),
  reveal: (path: string) => ipcRenderer.invoke('shell:reveal', path),
  openPath: (path: string) => ipcRenderer.invoke('shell:open', path),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch),
  sidecarInfo: () => ipcRenderer.invoke('sidecar:info'),
  sidecarRestart: () => ipcRenderer.invoke('sidecar:restart'),
  depsEnsure: async (root: string, onEvent?: EventHandler) => {
    const clientId = `c${++seq}`
    if (onEvent) handlers.set(clientId, onEvent)
    try { return await ipcRenderer.invoke('deps:ensure', root, clientId) } finally { handlers.delete(clientId) }
  },
  onSidecarLog: (fn: (entry: { stream: string; line: string }) => void) => {
    const listener = (_e: unknown, entry: { stream: string; line: string }) => fn(entry)
    ipcRenderer.on('sidecar:log', listener)
    return () => ipcRenderer.removeListener('sidecar:log', listener)
  }
}

contextBridge.exposeInMainWorld('knuaf', api)
export type KnuafApi = typeof api
