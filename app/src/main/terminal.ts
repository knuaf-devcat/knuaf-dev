/**
 * In-app agent terminals: spawn the real `claude` / `codex` CLI under node-pty inside the project.
 *
 * Deliberately free of `electron` imports like agent.ts: emit/venv/bundled/env arrive through the
 * constructor, so the service can be driven from e2e via electronApp.evaluate or a test harness.
 * `KNUAF_TERM_SHELL` swaps the agent binary for a bare shell (tests only).
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as pty from 'node-pty'
import { agentBinDirs, findExecutable, firstPromptFor, installSkill, skillTargets, skillVersion } from './agent'
import { subscriptionEnv } from './chat/contracts'
import type { TermInfo, TermKind, TermOpenOpts } from '../shared/term'

export type { TermInfo, TermKind }

export interface TerminalOpts {
  skillSource: string
  emit: (channel: 'term:data' | 'term:exit', payload: unknown) => void
  venvPython: (root: string | null) => string | null
  bundledPython?: () => string | null
  env?: NodeJS.ProcessEnv
}

/** Original-output ring buffer per terminal; enough for a reconnect without unbounded growth. */
const BUFFER_LIMIT = 256 * 1024

/** Terminal output minus ANSI/OSC control sequences: what the recovery log can safely keep. */
export function stripAnsi(data: string): string {
  return data
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b(?:\[[0-9:;<=>?]*[ -/]*[@-~]|[@-Z\\-_])/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

interface Session {
  info: TermInfo
  proc: pty.IPty
  buffer: string
  log: string
}

export class TerminalService {
  private sessions = new Map<string, Session>()
  private lastOutputAt = new Map<string, number>()
  constructor(private opts: TerminalOpts) {}

  private key(root: string, kind: TermKind) { return `${root}\0${kind}` }

  open(root: string, kind: TermKind, opts: TermOpenOpts): TermInfo {
    const key = this.key(root, kind)
    const existing = this.sessions.get(key)
    if (existing?.info.alive) return { ...existing.info }

    installSkill(this.opts.skillSource, skillTargets(root)[kind], skillVersion(this.opts.skillSource))

    const env = { ...subscriptionEnv(), ...(this.opts.env ?? {}) }
    const shell = env.KNUAF_TERM_SHELL
    const binary = shell ?? findExecutable(kind, env)
    if (!binary) throw new Error(`${kind === 'codex' ? 'Codex' : 'Claude Code'} 설치가 필요해요. 설치 안내를 열어 주세요.`)
    const args = shell ? [] : kind === 'claude' ? (opts.resume ? ['--continue'] : [firstPromptFor(opts.revision)]) : []

    const venv = this.opts.venvPython(root)
    const bundled = this.opts.bundledPython?.() ?? null
    env.PATH = [...agentBinDirs({ venvBin: venv ? dirname(venv) : null, bundledBin: bundled ? dirname(bundled) : null }), join(env.HOME ?? '', '.local', 'bin'), env.PATH ?? ''].filter(Boolean).join(':')
    env.KNUAF_DOC_APP = '1'
    env.TERM = 'xterm-256color'
    if (!env.LANG) env.LANG = 'ko_KR.UTF-8'

    const proc = pty.spawn(binary, args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: root, env })
    const session: Session = {
      info: { id: randomUUID(), root, kind, alive: true, pid: proc.pid },
      proc,
      buffer: '',
      log: join(root, '.knuaf-gui', `terminal-${kind}.log`),
    }
    mkdirSync(dirname(session.log), { recursive: true })
    proc.onData((data) => {
      session.buffer = (session.buffer + data).slice(-BUFFER_LIMIT)
      this.lastOutputAt.set(root, Date.now())
      appendFileSync(session.log, stripAnsi(data), { mode: 0o600 })
      this.opts.emit('term:data', { id: session.info.id, data })
    })
    proc.onExit(({ exitCode }) => {
      session.info.alive = false
      session.info.exitCode = exitCode
      this.opts.emit('term:exit', { id: session.info.id, exitCode })
    })
    this.sessions.set(key, session)
    return { ...session.info }
  }

  private session(id: string): Session {
    const s = [...this.sessions.values()].find((x) => x.info.id === id)
    if (!s) throw new Error('그 터미널은 없거나 이미 종료됐어요.')
    return s
  }

  replay(id: string): string {
    return this.session(id).buffer
  }

  write(id: string, data: string): void {
    this.session(id).proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.session(id).proc.resize(Math.max(1, cols | 0), Math.max(1, rows | 0))
  }

  kill(id: string): void {
    this.session(id).proc.kill('SIGHUP')
  }

  list(root: string): TermInfo[] {
    return [...this.sessions.values()].filter((s) => s.info.root === root).map((s) => ({ ...s.info }))
  }

  /** True while a live terminal for `root` produced output within `ms` — the agent may be mid-write. */
  activeWithin(root: string, ms: number): boolean {
    const at = this.lastOutputAt.get(root)
    if (at === undefined || Date.now() - at > ms) return false
    return [...this.sessions.values()].some((s) => s.info.root === root && s.info.alive)
  }

  closeAll(): void {
    for (const s of this.sessions.values()) {
      try { s.proc.kill('SIGHUP') } catch { /* already gone */ }
    }
    this.sessions.clear()
  }
}
