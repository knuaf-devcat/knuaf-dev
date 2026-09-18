import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Sidecar } from './sidecar'
import type { ProjectPeek, WindowInfo } from '../shared/types'
import { APP_ROOT, basePython, bundledPython, venvPython, wheelhouseDir } from './python'
import { agentApi, type AgentCtx, type AgentKind } from './agent'
import { openGuide } from './menu'
import { loadSettings, rememberRecent, saveSettings } from './settings'

/** Chrome hints the renderer uses to lay out its title bar; also used by main when creating the window. */
export function windowInfo(): WindowInfo {
  const darwin = process.platform === 'darwin'
  let reduceTransparency = false
  if (darwin) {
    try { reduceTransparency = systemPreferences.accessibilityDisplayShouldReduceTransparency } catch { /* older Electron / headless */ }
  }
  return { platform: process.platform, vibrancy: darwin && !reduceTransparency, titleBarInset: darwin, overlay: !darwin }
}

/** Read `<root>/project.json` without the sidecar; never throws. */
function peekProject(root: string): ProjectPeek {
  const out: ProjectPeek = { exists: false, hasProject: false, revision: null, project_id: null, mtime: null }
  try {
    if (!root || !existsSync(root)) return out
    out.exists = true
    const file = join(root, 'project.json')
    if (!existsSync(file)) return out
    out.hasProject = true
    out.mtime = statSync(file).mtimeMs
    const p = JSON.parse(readFileSync(file, 'utf-8')) as { revision?: unknown; project_id?: unknown }
    if (typeof p.revision === 'number') out.revision = p.revision
    if (typeof p.project_id === 'string') out.project_id = p.project_id
  } catch { /* unreadable or malformed: report what we know */ }
  return out
}

/** Every renderer request goes through here; the renderer never sees Node. */
export function registerIpc(sidecar: Sidecar, win: () => BrowserWindow | null, onRecentsChanged: () => void = () => {}): void {
  let currentRoot: string | null = null
  /** renderer clientId → sidecar request id, for `rpc:cancel`. */
  const inflight = new Map<string, string>()

  ipcMain.handle('rpc', async (_e, method: string, params: Record<string, unknown>, clientId: string) => {
    const w = win()
    try {
      const result = await sidecar.call(method, params, (event, data) => w?.webContents.send('rpc:event', { clientId, event, data }), (id) => inflight.set(clientId, id))
      return { result }
    } catch (error) {
      return { error }
    } finally {
      inflight.delete(clientId)
    }
  })

  ipcMain.handle('rpc:cancel', (_e, clientId: string) => {
    const id = inflight.get(clientId)
    if (id) sidecar.cancel(id)
    return !!id
  })

  ipcMain.handle('project:open', async (_e, root: string) => {
    if (!existsSync(root)) return { error: { code: 'not_found', message: '폴더가 없음: ' + root } }
    currentRoot = root
    const settings = loadSettings()
    try {
      const info = await sidecar.configure(root, settings.python_override)
      rememberRecent(root)
      onRecentsChanged()
      const w = win()
      if (w) {
        const name = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root
        w.setTitle(`${name} — knuaf-doc 동반 앱`)
        if (process.platform === 'darwin') w.setRepresentedFilename(root)
      }
      return { result: { root, hasProject: existsSync(join(root, 'project.json')), sidecar: info } }
    } catch (error) {
      return { error }
    }
  })

  ipcMain.handle('project:peek', (_e, root: string) => peekProject(root))

  ipcMain.handle('project:pick', async () => {
    const w = win()
    const r = await dialog.showOpenDialog(w!, { properties: ['openDirectory', 'createDirectory'], title: '논문 작업 폴더 선택' })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('file:pick', async (_e, opts: { title?: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string }) => {
    const w = win()
    const r = await dialog.showOpenDialog(w!, { properties: ['openFile'], title: opts.title, filters: opts.filters, defaultPath: opts.defaultPath ?? currentRoot ?? undefined })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('shell:reveal', (_e, path: string) => { shell.showItemInFolder(path); return true })
  ipcMain.handle('shell:open', (_e, path: string) => shell.openPath(path))

  ipcMain.handle('window:info', () => windowInfo())

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', (_e, patch) => { const s = saveSettings(patch); onRecentsChanged(); return s })
  const agentCtx = (): AgentCtx => ({
    home: app.getPath('home'), appRoot: APP_ROOT, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath,
    supportDir: join(app.getPath('userData'), 'launch'), dryRun: process.env.KNUAF_DRY_LAUNCH === '1',
    open: (p) => shell.openPath(p), venvPython, bundledPython
  })
  ipcMain.handle('agent:status', async () => { try { return { result: await agentApi.status(agentCtx()) } } catch (error) { return { error: { code: 'internal', message: String(error) } } } })
  ipcMain.handle('agent:install-skill', (_e, kind: AgentKind) => { try { return { result: agentApi.installSkill(agentCtx(), kind) } } catch (error) { return { error: { code: 'internal', message: String(error) } } } })
  ipcMain.handle('agent:launch', async (_e, opts: { root: string; kind: AgentKind; revision: number | null }) => {
    try {
      const install = agentApi.installSkill(agentCtx(), opts.kind)
      const launched = await agentApi.launch(agentCtx(), opts)
      return { result: { ...launched, install } }
    } catch (error) { return { error: { code: 'internal', message: String(error) } } }
  })
  ipcMain.handle('guide:open', () => { openGuide(); return true })
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, logs: app.getPath('logs'), userData: app.getPath('userData'), electron: process.versions.electron, node: process.versions.node }))
  ipcMain.handle('fs:is-dir', (_e, p: string) => { try { return statSync(p).isDirectory() } catch { return false } })

  ipcMain.handle('sidecar:info', () => ({ ...sidecar.status(), basePython: basePython(loadSettings().python_override), wheelhouse: wheelhouseDir() }))
  ipcMain.handle('sidecar:restart', async () => {
    try { return { result: await sidecar.restart() } } catch (error) { return { error } }
  })
  ipcMain.handle('deps:ensure', async (_e, root: string, clientId: string) => {
    const w = win()
    const params: Record<string, unknown> = { root, base_python: basePython(loadSettings().python_override) }
    const wheels = wheelhouseDir()
    if (wheels) { params.find_links = wheels; params.no_index = true }
    const onEvent = (event: string, data: unknown): void => w?.webContents.send('rpc:event', { clientId, event, data })
    const onId = (id: string): void => { inflight.set(clientId, id) }
    try {
      let result = await sidecar.call('deps.ensure', params, onEvent, onId)
      if (wheels && !(result as { ok: boolean }).ok) {
        // offline wheelhouse failed (e.g. platform mismatch): retry online
        delete params.find_links; delete params.no_index
        result = await sidecar.call('deps.ensure', params, onEvent, onId)
      }
      if ((result as { ok: boolean }).ok) await sidecar.configure(root, loadSettings().python_override)
      return { result }
    } catch (error) {
      return { error }
    } finally {
      inflight.delete(clientId)
    }
  })

  sidecar.on('log', (entry) => win()?.webContents.send('sidecar:log', entry))
  sidecar.on('exit', (entry) => win()?.webContents.send('sidecar:exit', entry))
}
