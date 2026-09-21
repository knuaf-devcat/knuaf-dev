import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { findExecutable, installSkill, skillState, skillVersion, VERSION_FILE } from '../agent'
import { ClaudeConnection } from './claude'
import { CodexConnection } from './codex'
import { subscriptionEnv, type AgentConnection, type AgentOptions } from './contracts'
import type { ChatSnapshot, PermissionRequest, Provider, ConnectionStatus } from '../../shared/chat'

export class ChatService {
  private snapshots = new Map<string, ChatSnapshot>()
  private connections = new Map<string, AgentConnection>()
  private owners = new Set<string>()
  private runs = new Map<string, Promise<void>>()
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
  }) {}
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
    try { return readFileSync(this.draftFile(root), 'utf8') } catch { return '' }
  }
  setDraft(root: string, text: string): void {
    this.draftPending.set(root, text)
    if (this.draftTimer) clearTimeout(this.draftTimer)
    this.draftTimer = setTimeout(() => this.flushDrafts(), 250)
  }
  /** 대기 중인 초안을 지금 쓴다. 종료 직전에도 불리므로 동기다. */
  flushDrafts(): void {
    if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null }
    for (const [root, text] of this.draftPending) {
      const file = this.draftFile(root)
      try {
        if (!text) { unlinkSync(file); continue }
        mkdirSync(dirname(file), { recursive: true })
        const tmp = file + '.tmp'
        writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, file)
      } catch { /* 폴더가 사라졌거나 종료 중 — 초안 때문에 종료를 막지 않는다 */ }
    }
    this.draftPending.clear()
  }
  private publish(s: ChatSnapshot) {
    const file = this.file(s.root, s.provider); mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'; writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 }); renameSync(tmp, file)
    this.opts.emit(structuredClone(s))
  }
  snapshot(root: string, provider: Provider): ChatSnapshot {
    const key = this.key(root, provider)
    let s = this.snapshots.get(key)
    if (!s) {
      const file = this.file(root, provider)
      if (existsSync(file)) {
        // Corrupt state must not silently reset the interview or its session.
        s = JSON.parse(readFileSync(file, 'utf8')) as ChatSnapshot
        if (!Array.isArray(s.messages) || s.provider !== provider) throw new Error('대화 기록을 읽지 못했어요. 기존 기록을 보존한 채 복구가 필요해요.')
        s.root = root; s.permission = undefined
        if (s.state === 'running' || s.state === 'permission') {
          s.state = 'interrupted'; s.error = '앱이 작업 도중 종료됐어요. 마지막 답변은 자동 재전송하지 않았어요.'
          for (const m of s.messages) if (m.delivery === 'pending') m.delivery = 'uncertain'
          // Persist the recovered state at once so the renderer and the file agree after restart.
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
    const key = this.key(root, provider)
    let c = this.connections.get(key)
    if (!c) {
      const options: AgentOptions = { binary: '', root, skill: this.skillDir(root, provider), env: this.opts.env ?? subscriptionEnv(this.pythonBinDirs(root)), openExternal: this.opts.openExternal, trusted: () => this.opts.isTrusted?.(root) ?? false }
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
    if (!this.opts.connectionFactory && !findExecutable(provider)) return { installed: false, connected: false, version: null, detail: '설치 안내를 열어 준비한 뒤 다시 확인해 주세요.' }
    return this.connection(root, provider).status()
  }
  async login(root: string, provider: Provider) { await this.connection(root, provider).login() }
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
  async close() { await Promise.all([...this.connections.entries()].map(async ([key, c]) => { await c.stop(); await this.runs.get(key) })) }
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
