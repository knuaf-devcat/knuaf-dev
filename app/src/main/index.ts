import { app, BrowserWindow, nativeImage, nativeTheme, systemPreferences } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Sidecar } from './sidecar'
import { registerIpc } from './ipc'
import { APP_ROOT } from './python'
import { installMenu, type MenuAction } from './menu'

// Tests point userData at a temp dir so first-run state (credit, recents) is isolated.
if (process.env.KNUAF_USER_DATA) app.setPath('userData', process.env.KNUAF_USER_DATA)

let win: BrowserWindow | null = null
const sidecar = new Sidecar()
const isMac = process.platform === 'darwin'
let pendingOpen: string | null = null

function sendMenu(action: MenuAction): void {
  if (win) win.webContents.send('menu', action)
  else if (action.type === 'open-recent') pendingOpen = action.root
}

app.setAboutPanelOptions({
  applicationName: 'knuaf-doc 동반 앱',
  applicationVersion: app.getVersion(),
  version: '',
  credits: 'knuaf-doc · 창업논문 작성 도우미\nprod. 특용작물전공 24학번 김대욱\n\n논문은 AI 도우미(Claude Code)가 채팅으로 쓰고, 이 앱은 저장 상태·검사·산출물·복구를 맡습니다.',
  copyright: 'MIT'
})

// Folders dropped on the Dock icon or opened from Finder.
app.on('open-file', (e, path) => { e.preventDefault(); sendMenu({ type: 'open-recent', root: path }) })

function chromeColors() {
  const dark = nativeTheme.shouldUseDarkColors
  return { bg: dark ? '#1c1d1c' : '#f5f5f4', bar: dark ? '#242625' : '#ecece9', symbol: dark ? '#ececea' : '#1c1f1b' }
}

function createWindow(): void {
  const reduceTransparency = isMac && systemPreferences.accessibilityDisplayShouldReduceTransparency
  const colors = chromeColors()
  const iconPng = join(APP_ROOT, 'build', 'icon.png')
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'knuaf-doc 동반 앱',
    backgroundColor: colors.bg,
    show: false,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 }, ...(reduceTransparency ? {} : { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const }) }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: colors.bar, symbolColor: colors.symbol, height: 40 } }),
    ...(!isMac && !app.isPackaged && existsSync(iconPng) ? { icon: iconPng } : {}),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.on('did-finish-load', () => { if (pendingOpen) { sendMenu({ type: 'open-recent', root: pendingOpen }); pendingOpen = null } })
  win.on('closed', () => { win = null })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

const single = app.requestSingleInstanceLock()
if (!single) app.quit()
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })
  app.whenReady().then(() => {
    if (isMac && !app.isPackaged) {
      const iconPng = join(APP_ROOT, 'build', 'icon.png')
      if (existsSync(iconPng)) app.dock?.setIcon(nativeImage.createFromPath(iconPng))
    }
    registerIpc(sidecar, () => win, () => installMenu(sendMenu))
    installMenu(sendMenu)
    createWindow()
    nativeTheme.on('updated', () => {
      if (!win || isMac) return
      const c = chromeColors()
      win.setTitleBarOverlay?.({ color: c.bar, symbolColor: c.symbol, height: 40 })
    })
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', () => { void sidecar.stop() })
}
