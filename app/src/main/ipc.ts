import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Sidecar } from './sidecar'
import { basePython, wheelhouseDir } from './python'
import { loadSettings, rememberRecent, saveSettings } from './settings'

/** Every renderer request goes through here; the renderer never sees Node. */
export function registerIpc(sidecar: Sidecar, win: () => BrowserWindow | null): void {
  let currentRoot: string | null = null

  ipcMain.handle('rpc', async (_e, method: string, params: Record<string, unknown>, clientId: string) => {
    const w = win()
    try {
      const result = await sidecar.call(method, params, (event, data) => w?.webContents.send('rpc:event', { clientId, event, data }))
      return { result }
    } catch (error) {
      return { error }
    }
  })

  ipcMain.handle('project:open', async (_e, root: string) => {
    if (!existsSync(root)) return { error: { code: 'not_found', message: '폴더가 없음: ' + root } }
    currentRoot = root
    const settings = loadSettings()
    try {
      const info = await sidecar.configure(root, settings.python_override)
      rememberRecent(root)
      return { result: { root, hasProject: existsSync(join(root, 'project.json')), sidecar: info } }
    } catch (error) {
      return { error }
    }
  })

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

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch))

  ipcMain.handle('sidecar:info', () => ({ ...sidecar.status(), basePython: basePython(loadSettings().python_override), wheelhouse: wheelhouseDir() }))
  ipcMain.handle('sidecar:restart', async () => {
    try { return { result: await sidecar.restart() } } catch (error) { return { error } }
  })
  ipcMain.handle('deps:ensure', async (_e, root: string, clientId: string) => {
    const w = win()
    const params: Record<string, unknown> = { root, base_python: basePython(loadSettings().python_override) }
    const wheels = wheelhouseDir()
    if (wheels) { params.find_links = wheels; params.no_index = true }
    try {
      let result = await sidecar.call('deps.ensure', params, (event, data) => w?.webContents.send('rpc:event', { clientId, event, data }))
      if (wheels && !(result as { ok: boolean }).ok) {
        // offline wheelhouse failed (e.g. platform mismatch): retry online
        delete params.find_links; delete params.no_index
        result = await sidecar.call('deps.ensure', params, (event, data) => w?.webContents.send('rpc:event', { clientId, event, data }))
      }
      if ((result as { ok: boolean }).ok) await sidecar.configure(root, loadSettings().python_override)
      return { result }
    } catch (error) {
      return { error }
    }
  })

  sidecar.on('log', (entry) => win()?.webContents.send('sidecar:log', entry))
  sidecar.on('exit', (entry) => win()?.webContents.send('sidecar:exit', entry))
}
