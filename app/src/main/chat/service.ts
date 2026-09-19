import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, lstatSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { findExecutable, installSkill, skillState, skillVersion, VERSION_FILE } from '../agent'
import { ClaudeConnection } from './claude'
import { CodexConnection } from './codex'
import { subscriptionEnv, type AgentConnection, type AgentOptions } from './contracts'
import type { ChatSnapshot, Provider, ConnectionStatus } from '../../shared/chat'

export class ChatService {
  private snapshots = new Map<string, ChatSnapshot>()
  private connections = new Map<string, AgentConnection>()
  private owners = new Set<string>()
  private runs = new Map<string, Promise<void>>()
  constructor(private opts: {
    skillSource: string; userData: string; env?: NodeJS.ProcessEnv
    emit: (s: ChatSnapshot) => void; openExternal: (url: string) => Promise<void>
    /** Test seam: build connections without spawning real agent processes (e2e/chat.spec.ts). */
    connectionFactory?: (provider: Provider, options: AgentOptions) => AgentConnection
    /** True while the app itself holds a sidecar write transaction; send() must not interleave. */
    sidecarBusy?: (root: string) => boolean
  }) {}
  private key(root: string, provider: Provider) { return `${root}\0${provider}` }
  private file(root: string, provider: Provider) { return join(root, '.knuaf-gui', `chat-${provider}.json`) }
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
  private skillDir(root: string, provider: Provider) { return join(root, provider === 'codex' ? '.agents' : '.claude', 'skills', 'knuaf-doc') }
  private connection(root: string, provider: Provider): AgentConnection {
    const key = this.key(root, provider)
    let c = this.connections.get(key)
    if (!c) {
      const options: AgentOptions = { binary: '', root, skill: this.skillDir(root, provider), env: this.opts.env ?? subscriptionEnv(), openExternal: this.opts.openExternal }
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
    try {
      await connection.run(text, s.sessionId, {
        session: id => { s.sessionId = id; this.publish(s) },
        skill: () => { s.skillLoaded = true; this.publish(s) },
        message: (id, text) => {
          const old = s.messages.find(m => m.id === id)
          if (old) old.text = text
          else s.messages.push({ id, role: 'assistant', text, at: new Date().toISOString() })
          this.publish(s)
        },
        permission: permission => { s.permission = permission; s.state = 'permission'; this.publish(s) }
      })
      s.messages.find(m => m.id === requestId)!.delivery = 'sent'; s.state = 'idle'
    } catch (e) {
      s.messages.find(m => m.id === requestId)!.delivery = 'uncertain'
      if (s.state !== 'interrupted') s.state = 'error'
      s.error = e instanceof Error ? e.message : '작업이 완료되지 않았어요.'
    } finally { s.permission = undefined; this.publish(s) }
  }
  respond(root: string, provider: Provider, id: string, allow: boolean) {
    const s = this.snapshots.get(this.key(root, provider))
    if (!s || s.permission?.id !== id) throw new Error('이미 종료된 권한 요청이에요.')
    this.connection(root, provider).respond(id, allow); s.permission = undefined; s.state = 'running'; this.publish(s)
  }
  async stop(root: string, provider: Provider) {
    const key = this.key(root, provider), s = this.snapshots.get(key)
    if (s && this.runs.has(key)) { s.state = 'interrupted'; this.publish(s) }
    await this.connections.get(key)?.stop(); await this.runs.get(key)
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
