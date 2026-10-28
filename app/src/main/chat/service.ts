import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { findExecutable, installSkill, skillState, skillVersion, VERSION_FILE } from '../agent'
import { readRecoverable, tmpOf, writeFileAtomic, type SafeWriteFs } from '../safeWrite'
import { ClaudeConnection } from './claude'
import { CodexConnection } from './codex'
import { subscriptionEnv, type AgentConnection, type AgentOptions } from './contracts'
import type { ChatModels, ChatModelInfo, ChatSnapshot, ModelChoice, PermissionRequest, Provider, ConnectionStatus } from '../../shared/chat'
import { effectiveModelChoice } from '../../shared/chat'

/** 저장된 대화 기록을 읽고 모양을 확인한다 — 망가졌으면 던진다. */
function parseChat(text: string, provider: Provider): ChatSnapshot {
  const v = JSON.parse(text) as ChatSnapshot
  if (!Array.isArray(v?.messages) || v.provider !== provider) throw new Error('대화 기록을 읽지 못했어요. 기존 기록을 보존한 채 복구가 필요해요.')
  return v
}

export class ChatService {
  private snapshots = new Map<string, ChatSnapshot>()
  private connections = new Map<string, AgentConnection>()
  private owners = new Set<string>()
  private runs = new Map<string, Promise<void>>()
  private shuttingDown = false
  /** 종료 시작과 동시에 새 연결·상태 확인을 막는다. 기존 연결은 close()가 정리한다. */
  beginShutdown(): void { this.shuttingDown = true }
  private ensureActive(): void {
    if (this.shuttingDown) throw new Error('앱을 종료하고 있어요.')
  }
  /**
   * 아직 카드로 올리지 못한 권한 요청 줄. 카드는 한 번에 하나만 뜨지만 요청은 동시에
   * 온다 — 도우미가 서브에이전트를 띄우면 그쪽 도구 호출도 같은 통로로 들어온다.
   *
   * 슬롯 하나에 덮어쓰던 때에는 덮인 요청이 아무에게도 닿지 않았다. 학생 화면에는
   * 승인 창이 아예 뜨지 않은 채 "도우미가 작업 중"만 남았고, 기다리던 도구 호출은
   * SDK 가 끊을 때까지 매달렸다가 도우미에게 "Tool permission request failed:
   * AbortError: Stream closed"로 돌아갔다. 도우미는 그것을 "쓰기 권한 차단"으로 읽고
   * 학생에게 앱에 없는 설정을 켜라고 안내했다.
   *
   * 디스크에 남기지 않는다 — 앱이 다시 뜨면 기다리던 쪽은 이미 죽어 있다.
   */
  private waiting = new Map<string, PermissionRequest[]>()
  constructor(private opts: {
    skillSource: string; userData: string; env?: NodeJS.ProcessEnv
    emit: (s: ChatSnapshot) => void; openExternal: (url: string) => Promise<void>
    /** Test seam: build connections without spawning real agent processes (e2e/chat.spec.ts). */
    connectionFactory?: (provider: Provider, options: AgentOptions) => AgentConnection
    /** True while the app itself holds a sidecar write transaction; send() must not interleave. */
    sidecarBusy?: (root: string) => boolean
    /** 도우미가 쓸 Python — 프로젝트 .venv 와 번들 CPython. */
    venvPython?: (root: string) => string | null
    bundledPython?: () => string | null
    /** 학생이 "이 폴더에서는 계속 허용"을 고른 폴더인가. */
    isTrusted?: (root: string) => boolean
    /**
     * 지금 설정에 남은 모델 선택(공급자별). 대화 파일이 아니라 설정 쪽이 정본이다 —
     * 이번 판은 대화 저장 형식을 그대로 둔다.
     */
    modelChoice?: (provider: Provider) => ModelChoice | null
    /**
     * 이 공급자로 모델을 고른 적이 있는가(설정에 흔적이 있는가). 없으면 해제를 저장하지도,
     * 기본값 복귀를 확인하지도 않는다 — 고른 적 없는 학생의 요청은 지금까지와 같아야 한다.
     */
    modelChosen?: (provider: Provider) => boolean
    /**
     * 고른 값을 설정에 남기는 통로(ipc 가 settings.json 에 쓴다). 저장을 여기서 하는 이유는
     * **선택의 선후**를 한 곳에서 지키기 위해서다 — 느린 검증이 나중에 끝나도 마지막 선택을
     * 덮지 않는다(검토 MC1-03).
     */
    storeModelChoice?: (provider: Provider, choice: ModelChoice | null) => void
    /** Test seam: 대화 기록·초안을 쓰는 파일시스템(e2e/safe-write.spec.ts 가 실패를 주입한다). */
    fs?: SafeWriteFs
  }) {}
  private get writeFs(): SafeWriteFs { return this.opts.fs ?? { writeFileSync, renameSync, unlinkSync, readFileSync: (p) => readFileSync(p, 'utf8') } }
  /** PATH 앞자리에 둘 인터프리터 bin 경로 — 프로젝트 .venv 가 번들보다 우선한다. */
  private pythonBinDirs(root: string): string[] {
    const venv = this.opts.venvPython?.(root) ?? null
    const bundled = this.opts.bundledPython?.() ?? null
    return [venv, bundled].filter((p): p is string => !!p).map((p) => dirname(p))
  }
  private key(root: string, provider: Provider) { return `${root}\0${provider}` }
  private file(root: string, provider: Provider) { return join(root, '.knuaf-gui', `chat-${provider}.json`) }
  /**
   * 아직 보내지 않은 입력. 대화 기록과 같은 자리에 두되 공급자별로 나누지 않는다 —
   * 학생이 쓰던 문장은 도우미를 바꿔도 그대로여야 한다. 폴더별로 따로 있어야
   * 프로젝트를 옮겼을 때 남의 초안이 따라가지 않는다(GUI 감사 GUI-01·GUI-06).
   */
  private draftFile(root: string) { return join(root, '.knuaf-gui', 'draft.txt') }
  /**
   * 초안은 메인이 쥐고 있다가 모아서 쓴다. 렌더러에 타이머를 두면 "쓰고 곧바로 종료"
   * 하는 학생의 입력이 타이머가 돌기 전에 사라진다 — 실제로 테스트가 그 틈을 밟았다.
   * 종료 직전 flushDrafts() 가 동기로 쓰므로 그 틈이 없다.
   */
  private draftPending = new Map<string, string>()
  private draftTimer: ReturnType<typeof setTimeout> | null = null
  draft(root: string): string {
    const pending = this.draftPending.get(root)
    if (pending !== undefined) return pending   // 아직 안 쓴 값이 디스크보다 최신이다
    let got: ReturnType<typeof readRecoverable<string>>
    try { got = readRecoverable(this.draftFile(root), (t) => t) } catch { return '' }
    if (!got) return ''
    // 저장이 막혀 `.tmp` 에만 남았던 글 — 다음 flush 가 제자리로 옮긴다(WIN-ONEDRIVE-R1-01).
    if (got.from === 'tmp') this.setDraft(root, got.value)
    return got.value
  }
  setDraft(root: string, text: string, expected?: string): boolean {
    // 첫 메시지 보관본의 성공 정리: 그 사이 편집된 초안은 건드리지 않는다(INT1-01).
    if (expected !== undefined && this.draft(root) !== expected) return false
    this.draftPending.set(root, text)
    if (this.draftTimer) clearTimeout(this.draftTimer)
    this.draftTimer = setTimeout(() => this.flushDrafts(), 250)
    return true
  }
  /** 대기 중인 초안을 지금 쓴다. 종료 직전에도 불리므로 동기다. */
  flushDrafts(): void {
    if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null }
    for (const [root, text] of this.draftPending) {
      const file = this.draftFile(root)
      if (!text) {
        // 빈 값도 최신 초안이다 — 지우기가 막혔는데 대기를 비우면 이미 보낸 글이 `draft()` 로 되살아난다
        // (WIN-ONEDRIVE-R1-02). 남은 `.tmp` 도 지운다: 그것도 되살리는 자리다.
        let cleared = true
        for (const path of [file, tmpOf(file)]) {
          try { this.writeFs.unlinkSync(path) } catch (e) {
            if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue
            cleared = false
            console.error(`[knuaf] 빈 초안을 지우지 못했어요: ${path} (${(e as NodeJS.ErrnoException)?.code ?? String(e)})`)
          }
        }
        if (cleared) this.draftPending.delete(root)
        continue
      }
      try { mkdirSync(dirname(file), { recursive: true }) } catch { /* 아래 쓰기가 같은 이유로 실패한다 */ }
      // 던지지 않는 공용 쓰기(WIN-ONEDRIVE). **성공한 것만** 지운다 — 실패하면 대기 값으로 남겨
      // 다음 flush 가 다시 시도하고, 그 사이 `draft()` 는 최신 글을 계속 돌려준다.
      if (writeFileAtomic(file, text, { mode: 0o600, fs: this.writeFs }).ok) this.draftPending.delete(root)
    }
  }
  /**
   * 대화 기록을 남기고 화면으로 내보낸다.
   *
   * 저장은 **던지지 않는** 공용 쓰기로 한다(WIN-ONEDRIVE): 윈도우에서 논문 폴더가 OneDrive
   * 동기화 폴더면 `renameSync` 가 `EPERM` 으로 막히는데, 이 함수는 에이전트 이벤트 콜백에서
   * 불리므로 예외가 올라가면 Electron 이 "A JavaScript error occurred in the main process"
   * 창을 띄운다. 저장이 실패해도 **메모리의 스냅샷을 그대로 내보낸다** — 화면 흐름을 막지 않는다.
   * 실패는 로그 한 줄로 강등한다(앱에 비치명 알림 자리가 없다 — §REPORT-WIN-ONEDRIVE).
   */
  private publish(s: ChatSnapshot) {
    const file = this.file(s.root, s.provider)
    try { mkdirSync(dirname(file), { recursive: true }) } catch { /* 아래 쓰기가 같은 이유로 실패한다 */ }
    writeFileAtomic(file, JSON.stringify(s, null, 2), { mode: 0o600, fs: this.writeFs, complete: (text) => { try { parseChat(text, s.provider); return true } catch { return false } } })
    this.opts.emit(structuredClone(s))
  }
  snapshot(root: string, provider: Provider): ChatSnapshot {
    const key = this.key(root, provider)
    let s = this.snapshots.get(key)
    if (!s) {
      // Corrupt state must not silently reset the interview or its session.
      // 저장이 막혀 완성본이 `.tmp` 에만 있으면 그것으로 되살린다(WIN-ONEDRIVE-R1-01).
      const got = readRecoverable(this.file(root, provider), (text) => parseChat(text, provider))
      if (got) {
        s = got.value
        s.root = root; s.permission = undefined
        // `.tmp` 에서 되살린 기록은 곧바로 다시 저장한다 — 이름 바꾸기가 풀렸으면 제자리로 간다.
        let persist = got.from === 'tmp'
        if (s.state === 'running' || s.state === 'permission') {
          s.state = 'interrupted'; s.error = '앱이 작업 도중 종료됐어요. 마지막 답변은 자동 재전송하지 않았어요.'
          for (const m of s.messages) if (m.delivery === 'pending') m.delivery = 'uncertain'
          // Persist the recovered state at once so the renderer and the file agree after restart.
          persist = true
        }
        if (persist) {
          this.snapshots.set(key, s)
          this.publish(s)
        }
      } else s = { root, provider, state: 'idle', messages: [] }
      this.snapshots.set(key, s)
    }
    return structuredClone(s)
  }
  busy(root: string) { try { return this.owners.has(realpathSync(root)) } catch { return false } }
  acquire(root: string): () => void {
    root = realpathSync(root)
    if (this.owners.has(root)) throw new Error('현재 작업이 끝나거나 중단된 뒤 다시 실행해 주세요.')
    this.owners.add(root)
    return () => { this.owners.delete(root) }
  }
  private skillDir(root: string, provider: Provider) { return join(root, provider === 'codex' ? '.agents' : '.claude', 'skills', 'knuaf-dev') }
  private connection(root: string, provider: Provider): AgentConnection {
    this.ensureActive()
    const key = this.key(root, provider)
    let c = this.connections.get(key)
    if (!c) {
      const options: AgentOptions = {
        binary: '', root, skill: this.skillDir(root, provider), env: this.opts.env ?? subscriptionEnv(this.pythonBinDirs(root)),
        openExternal: this.opts.openExternal, trusted: () => this.opts.isTrusted?.(root) ?? false,
        // 연결은 폴더·공급자마다 한 번만 만들어진다 — 선택은 전송할 때마다 다시 읽는다.
        modelChoice: () => this.effectiveChoice(provider),
        modelChosen: () => this.opts.modelChosen?.(provider) ?? false
      }
      if (this.opts.connectionFactory) {
        c = this.opts.connectionFactory(provider, options)
      } else {
        const binary = findExecutable(provider)
        if (!binary) throw new Error(`${provider === 'codex' ? 'Codex' : 'Claude Code'} 설치가 필요해요. 연결 설정의 설치 안내를 열어 주세요.`)
        options.binary = binary
        c = provider === 'codex' ? new CodexConnection(options) : new ClaudeConnection(options)
      }
      this.connections.set(key, c)
    }
    return c
  }
  async status(root: string, provider: Provider): Promise<ConnectionStatus> {
    this.ensureActive()
    if (!this.opts.connectionFactory && !findExecutable(provider)) return { installed: false, connected: false, version: null, detail: '설치 안내를 열어 준비한 뒤 다시 확인해 주세요.' }
    return this.connection(root, provider).status()
  }
  async login(root: string, provider: Provider) { await this.connection(root, provider).login() }

  // ---------------------------------------------------------------- 모델 고르기 (ChatGPT 쪽)
  /**
   * 마지막으로 성공한 모델 목록. 전송할 때 고른 모델이 아직 이 계정에 있는지 판정하는 데 쓴다 —
   * 요금제가 바뀌어 목록에서 사라진 모델을 계속 보내면 **모든 전송이 실패**한다.
   * 아직 목록을 못 받았으면(`null`) 선택을 그대로 보낸다(학생이 방금 고른 값을 이유 없이 무시하지 않는다).
   */
  private modelLists = new Map<Provider, ChatModelInfo[]>()
  /** 선택 호출의 선후 — 느린 검증이 나중 선택을 덮지 않게 한다(검토 MC1-03). */
  private selectionSeq = new Map<Provider, number>()
  /** 설정의 선택을 이 계정 목록에 비춰 정규화한다 — 고른 모델이 없으면 `null`(안 골름). */
  private effectiveChoice(provider: Provider): ModelChoice | null {
    const stored = this.opts.modelChoice?.(provider) ?? null
    return effectiveModelChoice(stored, this.modelLists.get(provider) ?? null)
  }
  /**
   * 이 계정이 쓸 수 있는 모델 목록. 통로가 없는 공급자(이번 판의 Claude)는 `supported:false` 로
   * 답한다 — 화면은 추천도 칩도 띄우지 않고 지금처럼 기본값으로 둔다.
   */
  async models(root: string | null, provider: Provider): Promise<ChatModels> {
    // 폴더를 정하기 전에도 계정 목록은 고를 수 있다. 전역 연결로는 턴을 보내지 않는다.
    const connection = root ? this.connection(root, provider) : this.globalConnection(provider)
    if (!connection.models) return { provider, supported: false, models: [], selected: null }
    try {
      const models = await connection.models()
      this.modelLists.set(provider, models)
      return { provider, supported: true, models, selected: effectiveModelChoice(this.opts.modelChoice?.(provider), models) }
    } catch (e) {
      // 목록을 못 받았다고 저장된 선택을 지우지 않는다 — 화면이 "안 골름"으로 보이면 고른 것이 사라진 줄 안다.
      return {
        provider, supported: true, models: [],
        selected: this.opts.modelChoice?.(provider) ?? null,
        error: e instanceof Error ? e.message : '모델 목록을 받지 못했어요.'
      }
    }
  }
  /**
   * 고른 모델·생각 깊이를 이 계정 목록으로 검증해 **설정에 남긴다**. `null` 은 "안 골름".
   *
   * 선택은 마지막 것이 이긴다: 호출마다 번호를 올리고, 목록을 기다리는 동안 더 새 선택이
   * 들어왔으면 저장하지 않고 **지금 설정값**을 돌려준다. 해제(null)는 목록을 기다리지 않으므로
   * 느린 선택 검증이 그 뒤에 끝나도 해제를 되살리지 못한다(검토 MC1-03).
   */
  async setModel(root: string | null, provider: Provider, choice: ModelChoice | null): Promise<ModelChoice | null> {
    const seq = (this.selectionSeq.get(provider) ?? 0) + 1
    this.selectionSeq.set(provider, seq)
    if (!choice || typeof choice.model !== 'string' || !choice.model.trim()) {
      // 고른 적 없는 학생의 "해제"는 아무것도 남기지 않는다 — 흔적을 만들면 다음 재개부터
      // 기본값 조회가 돌아, 고른 적 없는 학생의 동작이 달라진다(검토 L-02).
      if (this.opts.modelChosen?.(provider) ?? true) this.opts.storeModelChoice?.(provider, null)
      return null
    }
    const list = await this.models(root, provider)
    if (this.selectionSeq.get(provider) !== seq) return this.opts.modelChoice?.(provider) ?? null
    if (!list.supported) throw new Error('이 도우미는 아직 모델 고르기를 지원하지 않아요.')
    if (list.error) throw new Error(list.error)
    const picked = effectiveModelChoice(choice, list.models)
    if (!picked) throw new Error('이 계정에서 쓸 수 없는 모델이에요. 목록을 다시 불러와 주세요.')
    if (choice.effort && !picked.effort) throw new Error('이 모델은 그 생각 깊이를 지원하지 않아요.')
    this.opts.storeModelChoice?.(provider, picked)
    return picked
  }

  // ---------------------------------------------------------------- 전역 연결 (폴더 없이)
  //
  // 첫 실행은 폴더를 고르기 전에 "쓸 AI 를 연결"한다(IMPL-PLAN §4-3). 연결 대상은 CLI 전역
  // 계정이고 cwd 와 무관하므로(root 를 받는 것과 무관하게 같은 답이 나온다) 폴더별 연결과
  // **다른 맵**에 하나씩 둔다 — 키가 겹칠 자리가 없다.
  //
  // 이 연결은 상태 확인·로그인만 한다. 파일을 쓰는 일(스킬 설치)은 send() 안에서만
  // 일어나고 send() 는 폴더 연결만 쓴다 — 그래서 여기서는 논문 폴더도, connect-probe
  // 폴더도 건드리지 않는다. 그 성질을 깨려면 이 클래스에 새 메서드를 만들어야 한다.
  private globalRoot: string | null = null
  private globals = new Map<Provider, AgentConnection>()
  /** 전역 연결의 cwd — 빈 폴더. 논문 폴더가 아직 없어도 CLI 가 설 자리가 필요하다. */
  private connectRoot(): string {
    if (!this.globalRoot) {
      const dir = join(this.opts.userData, 'connect-probe')
      mkdirSync(dir, { recursive: true })
      this.globalRoot = dir
    }
    return this.globalRoot
  }
  private globalConnection(provider: Provider): AgentConnection {
    this.ensureActive()
    let c = this.globals.get(provider)
    if (!c) {
      const root = this.connectRoot()
      const options: AgentOptions = {
        binary: '', root, skill: this.skillDir(root, provider),
        env: this.opts.env ?? subscriptionEnv(this.pythonBinDirs(root)),
        openExternal: this.opts.openExternal, trusted: () => false
      }
      if (this.opts.connectionFactory) {
        c = this.opts.connectionFactory(provider, options)
      } else {
        const binary = findExecutable(provider)
        if (!binary) throw new Error(`${provider === 'codex' ? 'Codex' : 'Claude Code'} 설치가 필요해요. 연결 설정의 설치 안내를 열어 주세요.`)
        options.binary = binary
        c = provider === 'codex' ? new CodexConnection(options) : new ClaudeConnection(options)
      }
      this.globals.set(provider, c)
    }
    return c
  }
  /**
   * 폴더 없이 연결 상태를 본다. 설치가 없으면 `installed:false`, 있는데 핸드셰이크·계정
   * 조회가 실패하면(`probe:'failed'`) — 확인하지 못한 것을 "로그인 필요"로 꾸미지 않는다.
   */
  async globalStatus(provider: Provider): Promise<ConnectionStatus> {
    this.ensureActive()
    if (!this.opts.connectionFactory && !findExecutable(provider)) return { installed: false, connected: false, version: null, detail: '설치 안내를 열어 준비한 뒤 다시 확인해 주세요.' }
    try {
      return await this.globalConnection(provider).status()
    } catch (e) {
      return { installed: true, connected: false, version: null, probe: 'failed', detail: e instanceof Error ? e.message : '연결 상태를 확인하지 못했어요.' }
    }
  }
  async globalLogin(provider: Provider): Promise<void> { await this.globalConnection(provider).login() }
  /** 취소 뒤에는 연결을 버린다 — 다음 확인이 새 프로세스로 상태를 다시 묻는다. */
  async cancelLogin(provider: Provider): Promise<void> {
    const c = this.globals.get(provider)
    this.globals.delete(provider)
    if (!c) return
    if (c.cancelLogin) await c.cancelLogin()
    else await c.stop()
  }
  async reopenLogin(provider: Provider): Promise<void> {
    const c = this.globalConnection(provider)
    if (c.reopenLogin) await c.reopenLogin()
    else await c.login()
  }
  async send(root: string, provider: Provider, text: string, requestId: string) {
    if (!text.trim() || text.length > 100_000) throw new Error('답변을 입력해 주세요. 한 번에 100,000자까지 보낼 수 있어요.')
    this.snapshot(root, provider)
    const s = this.snapshots.get(this.key(root, provider))!
    if (s.messages.some(m => m.id === requestId)) return structuredClone(s)
    // The app may be mid-write (export/restore/init); agent writes must wait, not interleave.
    if (this.opts.sidecarBusy?.(root)) throw new Error('앱이 저장·검사 작업 중이에요. 끝난 뒤 답변을 보내 주세요.')
    const release = this.acquire(root)
    try {
      const skill = this.skillDir(root, provider)
      const version = skillVersion(this.opts.skillSource)
      const state = skillState(skill, version)
      if (state === 'missing') installSkill(this.opts.skillSource, skill, version)
      else if (state === 'outdated' || (s.skillHash && s.skillHash !== version)) {
        // A changed skill is never a send-blocker: reinstall (with backup) and note it in the transcript.
        const marker = join(skill, VERSION_FILE)
        const old = s.skillHash && s.skillHash !== version ? s.skillHash : existsSync(marker) ? readFileSync(marker, 'utf-8').trim() : '이전 버전'
        installSkill(this.opts.skillSource, skill, version)
        s.messages.push({ id: randomUUID(), role: 'system', text: `규칙집이 갱신됐어요 (이전 ${old} → 현재 ${version})`, at: new Date().toISOString() })
      }
      const connection = this.connection(root, provider)
      if (!(await connection.status()).connected) throw new Error('AI 계정 연결을 먼저 완료해 주세요.')
      // 전송 전 확인 — 여기서 던지면 보낸 말이 대화에 남지 않고 초안도 그대로다. 예전 모델로
      // 조용히 보내는 대신 학생에게 오류로 알린다(검토 MC1-01).
      await connection.prepare?.(s.sessionId)
      s.skillHash = version; s.skillLoaded = false; s.state = 'running'; s.error = undefined
      s.messages.push({ id: requestId, role: 'user', text, at: new Date().toISOString(), delivery: 'pending' })
      this.publish(s)
      const run = this.execute(s, connection, text, requestId).finally(release)
      this.runs.set(this.key(root, provider), run)
      void run.finally(() => this.runs.delete(this.key(root, provider)))
      return structuredClone(s)
    } catch (e) { release(); throw e }
  }
  private async execute(s: ChatSnapshot, connection: AgentConnection, text: string, requestId: string) {
    const key = this.key(s.root, s.provider)
    // 서버 재생(과거 턴)은 스냅샷에 assistant 기록이 하나도 없을 때만 — 이미 있으면
    // item-N/msg_* id가 달라 중복으로 들어온다.
    const replayHistory = !s.messages.some(m => m.role === 'assistant')
    /**
     * 답장이 오기 시작했으면 전달된 것이다. 예전에는 run() 이 끝나야 'sent' 로 바꿨는데,
     * 에이전트 턴은 몇 분씩 가므로 도우미가 눈앞에서 말하는 내내 학생 메시지에
     * "전송 중"이 붙어 있었다. 전달 여부와 턴 완료는 다른 사실이다.
     */
    const delivered = () => {
      const m = s.messages.find((x) => x.id === requestId)
      if (m?.delivery === 'pending') m.delivery = 'sent'
    }
    try {
      await connection.run(text, s.sessionId, {
        session: id => { s.sessionId = id; this.publish(s) },
        skill: () => { s.skillLoaded = true; this.publish(s) },
        message: (id, text) => {
          const old = s.messages.find(m => m.id === id)
          if (old) old.text = text
          else s.messages.push({ id, role: 'assistant', text, at: new Date().toISOString() })
          delivered()
          this.publish(s)
        },
        note: text => {
          s.messages.push({ id: randomUUID(), role: 'system', text, at: new Date().toISOString() })
          this.publish(s)
        },
        permission: permission => {
          const q = this.waiting.get(key) ?? []
          q.push(permission); this.waiting.set(key, q)
          this.showNextPermission(s, key)
          delivered(); this.publish(s)
        }
      }, replayHistory)
      delivered(); s.state = 'idle'
    } catch (e) {
      // 이미 답장이 왔다면 전달은 된 것이다 — 그 뒤에 실패한 것은 턴이지 전송이 아니다.
      const sentMsg = s.messages.find(m => m.id === requestId)!
      if (sentMsg.delivery === 'pending') sentMsg.delivery = 'uncertain'
      // 학생이 멈춘 것은 실패가 아니다 — 취소로 끝난 턴에 오류 문구를 붙이지 않는다.
      // (중단하면 연결이 끊겨 run 이 예외로 끝나므로 여기로 온다.)
      if (s.state !== 'stopped') {
        if (s.state !== 'interrupted') s.state = 'error'
        s.error = e instanceof Error ? e.message : '작업이 완료되지 않았어요.'
      }
    } finally { s.permission = undefined; this.waiting.delete(key); this.publish(s) }
  }
  /** 줄 맨 앞의 요청을 카드로 올린다. 이미 하나 떠 있으면 그대로 둔다. */
  private showNextPermission(s: ChatSnapshot, key: string): void {
    if (s.permission) return
    const q = this.waiting.get(key)
    if (!q?.length) return
    // 학생이 그 사이 "이 폴더에서는 계속 허용"을 골랐으면 줄에 남은 것도 묻지 않는다.
    // 같은 폴더를 두고 다시 묻는 것은 방금 받은 답을 무르는 일이다.
    if (this.opts.isTrusted?.(s.root)) {
      const c = this.connections.get(key)
      for (const p of q.splice(0)) { try { c?.respond(p.id, true) } catch { /* 이미 닫힌 요청 */ } }
      return
    }
    s.permission = q.shift()!; s.state = 'permission'
  }
  respond(root: string, provider: Provider, id: string, allow: boolean) {
    const key = this.key(root, provider)
    const s = this.snapshots.get(key)
    if (!s || s.permission?.id !== id) throw new Error('이미 종료된 권한 요청이에요.')
    this.connection(root, provider).respond(id, allow)
    s.permission = undefined
    this.showNextPermission(s, key)
    // 줄에 남은 것이 있으면 아직 학생 차례다 — 화면을 '작업 중'으로 되돌리지 않는다.
    if (!s.permission) s.state = 'running'
    this.publish(s)
  }
  async stop(root: string, provider: Provider) {
    const key = this.key(root, provider), s = this.snapshots.get(key)
    if (s && this.runs.has(key)) { s.state = 'stopped'; s.error = undefined; this.publish(s) }
    // 멈춘 연결은 버린다 — 다음 send/status 가 새 연결을 열어야 '다시 확인'이 살아난다.
    await this.connections.get(key)?.stop(); this.connections.delete(key)
    await this.runs.get(key)
  }
  async close() {
    this.beginShutdown()
    await Promise.all([...this.connections.entries()].map(async ([key, c]) => { await c.stop(); await this.runs.get(key) }))
    await Promise.all([...this.globals.values()].map((c) => c.stop()))
    this.globals.clear()
  }
}

/** Personal validation never writes the user's original thesis or the source backup. */
export function personalProject(source: string | null, userData: string): string {
  const base = join(userData, 'projects'); mkdirSync(base, { recursive: true })
  if (source) {
    source = realpathSync(source)
    if (source.split(sep).includes('backups')) throw new Error('보관본은 작업 대상으로 열지 않아요.')
    const inside = relative(realpathSync(base), source)
    if (inside && !inside.startsWith('..') && !resolve(inside).startsWith(base) && existsSync(join(source, '.knuaf-gui', 'personal-copy.json'))) return source
    if (source === base || relative(source, base).split(sep)[0] !== '..') throw new Error('앱 작업 폴더의 상위 폴더는 복사할 수 없어요.')
  }
  const root = join(base, `${source ? basename(source) : '새 논문'}-${randomUUID().slice(0, 8)}`)
  if (source) cpSync(source, root, { recursive: true, dereference: false, filter: p => !lstatSync(p).isSymbolicLink() && !['backups', '.git', '.venv', 'node_modules', '.knuaf-gui'].includes(basename(p)) })
  else mkdirSync(root)
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  writeFileSync(join(root, '.knuaf-gui', 'personal-copy.json'), JSON.stringify({ source, createdAt: new Date().toISOString() }))
  return root
}
