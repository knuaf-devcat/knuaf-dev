import { app, BrowserWindow, nativeImage, nativeTheme, systemPreferences } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Sidecar } from './sidecar'
import { registerIpc } from './ipc'
import type { ChatService } from './chat/service'
import { APP_ROOT } from './python'
import { installMenu, type MenuAction } from './menu'
import { LEGACY_USERDATA_NAMES, migrateUserDataDir } from './userdata'
import { APP_NAME } from '../shared/name'

// Tests point userData at a temp dir so first-run state (credit, recents) is isolated.
if (process.env.KNUAF_USER_DATA) app.setPath('userData', process.env.KNUAF_USER_DATA)
// 표시이름이 바뀌며 생긴 옛 userData 폴더에서 설정을 이어 받는다(userdata.ts).
// 테스트(KNUAF_USER_DATA 지정)에서는 돌리지 않는다.
else migrateUserDataDir(app.getPath('userData'), LEGACY_USERDATA_NAMES.map((n) => join(app.getPath('appData'), n)))

let win: BrowserWindow | null = null
const sidecar = new Sidecar()
let chat: ChatService | null = null
let quitting = false
const isMac = process.platform === 'darwin'
// e2e 숨김 실행(`KNUAF_E2E_HIDDEN=1`, `e2e/helpers.ts` 가 기본으로 켠다): 창은 만들고 렌더는
// 유지하되 화면·Dock·⌘Tab·앱 활성화에는 나타나지 않는다. 이 변수가 없으면 앱 동작은 전과 같다.
// 창을 눈으로 봐야 할 때는 `KNUAF_E2E_VISIBLE=1` 로 끈다(`window-shots.spec.ts`).
const hidden = process.env.KNUAF_E2E_HIDDEN === '1' && process.env.KNUAF_E2E_VISIBLE !== '1'
// 창을 만들기 전에, 그리고 앱이 '일반 앱'으로 잠깐 활성화될 틈도 없이 정책을 바꾼다 — ready 를
// 기다리면 그 사이 새로 뜬 앱이 맨 앞을 가져간다(숨김 실행 실측: 다른 e2e 가 함께 돌 때 2/408·35/394표본).
// 'accessory' 가 아니라 'prohibited' 인 이유는 AppKit 문서 그대로다: accessory 는 "활성화될 수 있고",
// prohibited 는 "활성화될 수 없다". 이 앱은 화면에 뜰 일이 아예 없으므로 둘 중 하나만 맞다.
// (이 분기는 e2e(`KNUAF_E2E_HIDDEN=1`)에서만 켜진다 — 일반 실행의 창·Dock 동작은 그대로다.)
if (hidden && isMac) {
  app.setActivationPolicy('prohibited')
  app.dock?.hide()
}
let pendingOpen: string | null = null

function sendMenu(action: MenuAction): void {
  if (win) win.webContents.send('menu', action)
  else if (action.type === 'open-recent') pendingOpen = action.root
}

app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion(),
  version: '',
  credits: 'KNUAF-Dev · 창업논문 작성 도우미\nprod. 특용작물전공 24학번 김대욱 · 산업곤충전공 24학번 이준재\n\n논문은 AI 도우미(Claude Code)가 채팅으로 쓰고, 이 앱은 저장 상태·검사·산출물·복구를 맡습니다.',
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
    title: APP_NAME,
    backgroundColor: colors.bg,
    show: false,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 }, ...(reduceTransparency ? {} : { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const }) }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: colors.bar, symbolColor: colors.symbol, height: 40 } }),
    ...(!isMac && !app.isPackaged && existsSync(iconPng) ? { icon: iconPng } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      // 숨긴 창에서도 렌더·스크린샷이 살아 있어야 한다(`paintWhenInitiallyHidden` 기본값에 기대지 않는다).
      ...(hidden ? { backgroundThrottling: false, paintWhenInitiallyHidden: true } : {})
    }
  })
  if (!hidden) win.once('ready-to-show', () => win?.show())
  win.webContents.on('did-finish-load', () => { if (pendingOpen) { sendMenu({ type: 'open-recent', root: pendingOpen }); pendingOpen = null } })
  win.on('closed', () => { win = null })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

const single = app.requestSingleInstanceLock()
if (!single) app.quit()
else {
  app.on('second-instance', () => { if (win && !hidden) { if (win.isMinimized()) win.restore(); win.focus() } })
  app.whenReady().then(() => {
    if (isMac && !app.isPackaged && !hidden) {
      const iconPng = join(APP_ROOT, 'build', 'icon.png')
      if (existsSync(iconPng)) app.dock?.setIcon(nativeImage.createFromPath(iconPng))
    }
    const services = registerIpc(sidecar, () => win, () => installMenu(sendMenu))
    chat = services.chat
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
  app.on('before-quit', (e) => {
    chat?.flushDrafts()   // 아직 안 쓴 학생 입력을 먼저 남긴다 — 동기다
    void sidecar.stop()
    // Let in-flight agent connections finish their shutdown before the process exits.
    if (chat && !quitting) {
      quitting = true
      e.preventDefault()
      void chat.close().finally(() => app.quit())
    }
  })
}
