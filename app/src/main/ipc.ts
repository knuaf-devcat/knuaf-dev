import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences } from 'electron'
import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { mkdir, lstat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { Sidecar } from './sidecar'
import type { ProjectPeek, WindowInfo } from '../shared/types'
import type { ModelChoice, Provider } from '../shared/chat'
import { APP_ROOT, basePython, bundledPython, venvPython, wheelhouseDir } from './python'
import { cancelRuntimeInstall, cleanupRuntime, installRuntime, runtimeStatus } from './runtime'
import { agentApi, skillSource, type AgentCtx, type AgentKind } from './agent'
import { ChatService } from './chat/service'
import { openGuide } from './menu'
import { loadSettings, rememberRecent, saveSettings } from './settings'
import { APP_NAME } from '../shared/name'
import { hideAppDirs } from './hidden'
import { projectFolderName } from '../shared/project-folder'

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

/** One level down: `root/<dir>/project.json` — a helper init in a wrong subfolder. */
/** 신뢰 목록의 열쇠 — 심링크와 한글 정규화 차이로 같은 폴더가 달리 보이지 않게. */
function trustKey(root: string): string {
  try { return realpathSync(root).normalize('NFC') } catch { return resolve(root).normalize('NFC') }
}

function findNestedProject(root: string): string | null {
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'backups' && existsSync(join(root, e.name, 'project.json'))) return e.name
    }
  } catch { /* unreadable root: nothing to report */ }
  return null
}

/** Every renderer request goes through here; the renderer never sees Node. Returns the services so index.ts can close them on quit. */
export function registerIpc(sidecar: Sidecar, win: () => BrowserWindow | null, onRecentsChanged: () => void = () => {}): { chat: ChatService } {
  let currentRoot: string | null = null
  /** renderer clientId → in-flight sidecar request, for `rpc:cancel` and the agent-busy gate. */
  const inflight = new Map<string, { id: string; method: string }>()

  /**
   * The generic `rpc` channel forwards a method name and a params object straight
   * to the sidecar, so it is the one wide spot in an otherwise narrow preload API.
   * Params that name a program to execute are decided by main (see `deps:ensure`,
   * which calls the sidecar directly and is unaffected); a renderer value for them
   * is dropped rather than passed through as argv[0]. `timeout` is clamped so a
   * huge value cannot disable the sidecar's wall-clock kill.
   */
  const EXECUTABLE_PARAMS = ['base_python', 'node', 'pnpm', 'kordoc'] as const
  const MAX_TIMEOUT_SECONDS = 1800
  function sanitiseRpcParams(params: Record<string, unknown>): Record<string, unknown> {
    const out = { ...(params ?? {}) }
    for (const key of EXECUTABLE_PARAMS) delete out[key]
    if ('timeout' in out) {
      const n = Number(out.timeout)
      if (!Number.isFinite(n) || n <= 0) delete out.timeout
      else out.timeout = Math.min(n, MAX_TIMEOUT_SECONDS)
    }
    return out
  }

  const AGENT_BUSY_MESSAGE = 'AI 도우미가 작업 중이에요. 답변이 끝난 뒤 다시 시도해 주세요.'
  // chat is created below; handlers only run after registerIpc returns, so the closure is safe.
  const agentBusy = (root: string | null): boolean => !!root && chat.busy(root)

  ipcMain.handle('rpc', async (_e, method: string, rawParams: Record<string, unknown>, clientId: string) => {
    const w = win()
    const params = sanitiseRpcParams(rawParams)
    const root = typeof params.root === 'string' ? params.root : currentRoot
    if (sidecar.isWrite(method) && agentBusy(root)) return { error: { code: 'agent_busy', message: AGENT_BUSY_MESSAGE } }
    try {
      const result = await sidecar.call(method, params, (event, data) => w?.webContents.send('rpc:event', { clientId, event, data }), (id) => inflight.set(clientId, { id, method }))
      return { result }
    } catch (error) {
      return { error }
    } finally {
      inflight.delete(clientId)
    }
  })

  ipcMain.handle('rpc:cancel', (_e, clientId: string) => {
    const entry = inflight.get(clientId)
    if (entry) sidecar.cancel(entry.id)
    return !!entry
  })

  ipcMain.handle('project:open', async (_e, root: string) => {
    if (!existsSync(root)) return { error: { code: 'not_found', message: '폴더가 없음: ' + root } }
    currentRoot = root
    const settings = loadSettings()
    try {
      const info = await sidecar.configure(root, settings.python_override)
      rememberRecent(root)
      onRecentsChanged()
      // 앱이 만든 작업 폴더는 윈도우 탐색기에서 숨긴다 — 학생에게는 자기 자료만 보이게(hidden.ts).
      hideAppDirs(root)
      const w = win()
      if (w) {
        const name = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root
        w.setTitle(`${name} — ${APP_NAME}`)
        if (process.platform === 'darwin') w.setRepresentedFilename(root)
      }
      const hasProject = existsSync(join(root, 'project.json'))
      // 도우미가 하위 폴더를 만들어 거기 init한 경우(knuaf-work 등): 조용히 빈 화면을
      // 보여 주는 대신 어디에 만들었는지 알려 준다.
      const nestedProject = hasProject ? null : findNestedProject(root)
      return { result: { root, hasProject, nestedProject, sidecar: info } }
    } catch (error) {
      // 실패한 **이 선택**의 python·kind 를 같이 돌려준다(PY-D1-03). renderer 의 store.sidecar 는
      // 성공 분기에서만 갱신되므로, 첫 실패에서 이전 프로젝트의 값으로 버튼을 판단하면 안 된다.
      return { error, sidecar: sidecar.status(), startupFailed: true }
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

  /** Resolve relPath inside root; anything escaping the project folder is refused. */
  const insideRoot = (root: string, relPath: string): string | null => {
    if (typeof root !== 'string' || !root || typeof relPath !== 'string' || !relPath) return null
    const base = resolve(root)
    const p = resolve(base, relPath)
    // NFC/NFD: macOS 는 파일명을 NFD 로 주고 사람·모델이 쓴 경로는 NFC 다.
    // 정규화하지 않으면 폴더 안의 한글 경로가 거부된다(claude.ts outsideRoot 와 같은 이유).
    const n = (x: string) => x.normalize('NFC')
    if (n(p) !== n(base) && !n(p).startsWith(n(base) + sep)) return null
    return p
  }
  const FILE_READ_EXTS = new Set(['.pdf', '.md', '.txt'])
  const FILE_READ_MAX = 50 * 1024 * 1024

  ipcMain.handle('file:exists', (_e, root: string, relPath: string) => {
    const p = insideRoot(root, relPath)
    return { result: !!p && existsSync(p) }
  })

  ipcMain.handle('file:read', (_e, root: string, relPath: string) => {
    const p = insideRoot(root, relPath)
    if (!p) return { error: { code: 'invalid_params', message: '작업 폴더 밖 경로는 읽지 않아요: ' + String(relPath) } }
    if (!FILE_READ_EXTS.has(extname(p).toLowerCase())) return { error: { code: 'invalid_params', message: '미리보기로 읽을 수 있는 형식이 아니에요: ' + extname(p) } }
    try {
      if (statSync(p).size > FILE_READ_MAX) return { error: { code: 'invalid_params', message: '파일이 너무 커서 미리보기하지 않아요(50MB 초과).' } }
      return { result: readFileSync(p) }
    } catch (error) {
      return { error: { code: 'not_found', message: String(error instanceof Error ? error.message : error) } }
    }
  })

  ipcMain.handle('file:save-as', async (_e, root: string, relPath: string) => {
    const p = insideRoot(root, relPath)
    if (!p) return { error: { code: 'invalid_params', message: '작업 폴더 밖 경로는 저장할 수 없어요: ' + String(relPath) } }
    const w = win()
    const r = await dialog.showSaveDialog(w!, { defaultPath: basename(p), title: '다른 이름으로 저장' })
    if (r.canceled || !r.filePath) return { result: null }
    try {
      copyFileSync(p, r.filePath)
      return { result: r.filePath }
    } catch (error) {
      return { error: { code: 'internal', message: String(error instanceof Error ? error.message : error) } }
    }
  })

  ipcMain.handle('window:info', () => windowInfo())

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', (_e, patch) => { const s = saveSettings(patch); onRecentsChanged(); return s })
  const agentCtx = (): AgentCtx => ({
    home: app.getPath('home'), appRoot: APP_ROOT, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath,
    supportDir: join(app.getPath('userData'), 'launch'), dryRun: process.env.KNUAF_DRY_LAUNCH === '1',
    open: (p) => shell.openPath(p), venvPython, bundledPython
  })
  ipcMain.handle('agent:status', async (_e, root: string | null) => { try { return { result: await agentApi.status(agentCtx(), root ?? currentRoot) } } catch (error) { return { error: { code: 'internal', message: String(error) } } } })
  ipcMain.handle('agent:install-skill', (_e, kind: AgentKind, root: string | null) => { try { return { result: agentApi.installSkill(agentCtx(), kind, root ?? currentRoot) } } catch (error) { return { error: { code: 'internal', message: String(error) } } } })
  ipcMain.handle('agent:launch', async (_e, opts: { root: string; kind: AgentKind; revision: number | null }) => {
    try {
      const install = agentApi.installSkill(agentCtx(), opts.kind, opts.root ?? currentRoot)
      const launched = await agentApi.launch(agentCtx(), opts)
      return { result: { ...launched, install } }
    } catch (error) { return { error: { code: 'internal', message: String(error) } } }
  })

  const chat = new ChatService({
    skillSource: skillSource(APP_ROOT, app.isPackaged, process.resourcesPath),
    userData: app.getPath('userData'),
    emit: (s) => win()?.webContents.send('chat:snapshot', s),
    openExternal: (url) => shell.openExternal(url),
    // The reverse gate: while the app holds a write transaction, agent sends must wait.
    sidecarBusy: () => [...inflight.values()].some((e) => sidecar.isWrite(e.method)),
    // 도우미에게도 프로젝트 .venv 와 번들 인터프리터를 건넨다 — Homebrew 없는 맥에서 막히지 않게.
    venvPython,
    bundledPython,
    // 전역 기본이 '묻지 않기'면 폴더를 가리지 않는다. 'ask' 로 되돌려도 학생이 권한 카드에서
    // 직접 "이 폴더에서는 계속 허용"을 누른 폴더는 그대로 산다 — 받은 답을 무르지 않는다.
    // loadSettings 를 호출할 때마다 새로 읽으므로 설정을 바꾸면 다음 도구 호출부터 반영된다.
    isTrusted: (root) => {
      const s = loadSettings()
      return s.permission_mode === 'trust' || (s.trusted_roots ?? []).includes(trustKey(root))
    },
    // 고른 모델은 설정에 남는다(대화 파일 형식은 그대로). 전송할 때마다 새로 읽으므로
    // 칩에서 바꾼 값이 다음 메시지부터 적용된다.
    modelChoice: (provider) => loadSettings().chat_models?.[provider] ?? null,
    // "고른 적 있음"은 설정에 그 공급자 키가 있는지로 판정한다. 키가 없으면(처음부터 안 고름)
    // 기본값 조회·복귀 확인을 하지 않아, 요청이 지금까지와 똑같이 나간다(검토 L-02).
    modelChosen: (provider) => {
      const m = loadSettings().chat_models
      return !!m && typeof m === 'object' && Object.prototype.hasOwnProperty.call(m, provider)
    },
    // 고른 값은 설정에 남는다(대화 파일 형식은 그대로). 저장 위치를 서비스가 정하는 이유는
    // 선택의 선후를 한 곳에서 지키기 위해서다(검토 MC1-03).
    storeModelChoice: (provider, choice) => {
      saveSettings({ chat_models: { ...(loadSettings().chat_models ?? {}), [provider]: choice } })
    }
  })
  const chatFail = (e: unknown): { error: { code: string; message: string } } => ({ error: { code: 'chat', message: e instanceof Error ? e.message : String(e) } })
  ipcMain.handle('chat:snapshot', (_e, root: string, provider: Provider) => { try { return { result: chat.snapshot(root, provider) } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:draft', (_e, root: string) => { try { return { result: chat.draft(root) } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:set-draft', (_e, root: string, text: string, expected?: string) => { try { return { result: chat.setDraft(root, text, expected) } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:status', async (_e, root: string, provider: Provider) => { try { return { result: await chat.status(root, provider) } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:login', async (_e, root: string, provider: Provider) => { try { await chat.login(root, provider); return { result: true } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:send', async (_e, root: string, provider: Provider, text: string, requestId: string) => {
    try {
      const result = await chat.send(root, provider, text, requestId)
      hideAppDirs(root)   // 첫 전송이 규칙집(.agents·.claude)과 대화 기록(.knuaf-gui)을 만든다
      return { result }
    } catch (e) { return chatFail(e) }
  })
  ipcMain.handle('project:trust', (_e, root: string, on: boolean) => {
    const key = trustKey(root)
    const cur = new Set(loadSettings().trusted_roots ?? [])
    on ? cur.add(key) : cur.delete(key)
    saveSettings({ trusted_roots: [...cur] })
    return { result: [...cur] }
  })
  ipcMain.handle('chat:respond', (_e, root: string, provider: Provider, id: string, allow: boolean) => { try { chat.respond(root, provider, id, allow); return { result: true } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:stop', async (_e, root: string, provider: Provider) => { try { await chat.stop(root, provider); return { result: true } } catch (e) { return chatFail(e) } })
  /**
   * 모델 칩의 뒷단. 목록은 계정에 묻고(`model/list`), 고른 값은 **설정에** 남긴다 —
   * `.knuaf-gui/chat-*.json` 저장 형식은 이번 판에서 건드리지 않는다.
   */
  ipcMain.handle('chat:models', async (_e, root: string | null, provider: Provider) => { try { return { result: await chat.models(root, provider) } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:set-model', async (_e, root: string | null, provider: Provider, choice: ModelChoice | null) => {
    // 저장·순서는 ChatService 가 맡는다(목록 검증과 저장 사이에 새 선택이 끼어드는 경합).
    try { return { result: await chat.setModel(root, provider, choice) } } catch (e) { return chatFail(e) }
  })

  // 폴더 없이 쓰는 연결 — 첫 실행 화면(온보딩)이 폴더를 고르기 전에 쓴다. root 인자가 없다.
  // 대화·스킬 계약은 그대로다: 이 연결로는 아무것도 보낼 수 없다(service.ts 전역 연결 주석).
  ipcMain.handle('connect:status', async (_e, provider: Provider) => { try { return { result: await chat.globalStatus(provider) } } catch (e) { return chatFail(e) } })
  ipcMain.handle('connect:login', async (_e, provider: Provider) => { try { await chat.globalLogin(provider); return { result: true } } catch (e) { return chatFail(e) } })
  ipcMain.handle('connect:cancel', async (_e, provider: Provider) => { try { await chat.cancelLogin(provider); return { result: true } } catch (e) { return chatFail(e) } })
  ipcMain.handle('connect:reopen', async (_e, provider: Provider) => { try { await chat.reopenLogin(provider); return { result: true } } catch (e) { return chatFail(e) } })

  ipcMain.handle('guide:open', () => { openGuide(); return true })
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, logs: app.getPath('logs'), userData: app.getPath('userData'), electron: process.versions.electron, node: process.versions.node, buildDate: __APP_BUILD_DATE__, buildCommit: __APP_BUILD_COMMIT__ }))
  ipcMain.handle('fs:is-dir', (_e, p: string) => { try { return statSync(p).isDirectory() } catch { return false } })

  ipcMain.handle('sidecar:info', () => ({ ...sidecar.status(), basePython: basePython(loadSettings().python_override), wheelhouse: wheelhouseDir() }))
  ipcMain.handle('sidecar:restart', async () => {
    try { return { result: await sidecar.restart() } } catch (error) { return { error } }
  })
  /**
   * 앱 전용 Python 런타임(D7). 진행 이벤트는 기존 `rpc:event` 채널로 clientId 에만 보낸다.
   * 설치는 프로세스 전역 1건 — 진행 중 재요청은 main 이 같은 약속에 합류시킨다.
   */
  ipcMain.handle('runtime:status', () => ({ result: runtimeStatus() }))
  ipcMain.handle('runtime:install', async (_e, clientId: string) => {
    const w = win()
    try {
      await installRuntime((event) => w?.webContents.send('rpc:event', { clientId, event: 'progress', data: event }))
      // 교체가 아니라 새 폴더 게시이므로 사이드카만 새 선택으로 다시 띄운다. 실패는 무시하고
      // 지금 상태를 돌려준다 — 설치 성공을 폴더 복구 성공으로 표시하지 않는다.
      let info = sidecar.status()
      try { info = await sidecar.restart() } catch { /* 재시작 실패는 호출자가 재시도로 다룬다 */ }
      cleanupRuntime()
      return { result: { installed: true, sidecar: info } }
    } catch (error) {
      return { error }
    }
  })
  ipcMain.handle('runtime:cancel', () => ({ result: cancelRuntimeInstall() }))
  ipcMain.handle('deps:ensure', async (_e, root: string, clientId: string) => {
    const w = win()
    if (agentBusy(root)) return { error: { code: 'agent_busy', message: AGENT_BUSY_MESSAGE } }
    const params: Record<string, unknown> = { root, base_python: basePython(loadSettings().python_override) }
    const wheels = wheelhouseDir()
    if (wheels) { params.find_links = wheels; params.no_index = true }
    const onEvent = (event: string, data: unknown): void => w?.webContents.send('rpc:event', { clientId, event, data })
    const onId = (id: string): void => { inflight.set(clientId, { id, method: 'deps.ensure' }) }
    try {
      let result = await sidecar.call('deps.ensure', params, onEvent, onId)
      if (wheels && !(result as { ok: boolean }).ok) {
        // offline wheelhouse failed (e.g. platform mismatch): retry online
        delete params.find_links; delete params.no_index
        result = await sidecar.call('deps.ensure', params, onEvent, onId)
      }
      if ((result as { ok: boolean }).ok) await sidecar.configure(root, loadSettings().python_override)
      hideAppDirs(root)   // 준비가 이 폴더의 .venv 를 만든다
      return { result }
    } catch (error) {
      return { error }
    } finally {
      inflight.delete(clientId)
    }
  })
  ipcMain.handle('project:create-folder', async (_e, title: unknown) => {
    if (typeof title !== 'string') return { error: { code: 'invalid_name', message: '논문 이름을 확인해 주세요.' } }
    const parent = join(app.getPath('documents'), 'knuaf-dev')
    try {
      await mkdir(parent, { recursive: true })
      if (!(await lstat(parent)).isDirectory()) throw new Error('논문 폴더 위치가 실제 폴더가 아닙니다.')
      const name = projectFolderName(title)
      for (let n = 1; n <= 10000; n++) {
        const root = join(parent, n === 1 ? name : `${name} (${n})`)
        try { await mkdir(root); return { result: { root } } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      throw new Error('같은 이름의 폴더가 너무 많아요.')
    } catch (error) {
      return { error: { code: 'create_folder_failed', message: String(error) } }
    }
  })

  sidecar.on('log', (entry) => win()?.webContents.send('sidecar:log', entry))
  sidecar.on('exit', (entry) => win()?.webContents.send('sidecar:exit', entry))
  return { chat }
}
