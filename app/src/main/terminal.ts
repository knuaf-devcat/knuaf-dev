/**
 * In-app agent terminals: spawn the real `claude` / `codex` CLI under node-pty inside the project.
 *
 * Deliberately free of `electron` imports like agent.ts: emit/venv/bundled/env arrive through the
 * constructor, so the service can be driven from e2e via electronApp.evaluate or a test harness.
 * `KNUAF_TERM_SHELL` swaps the agent binary for a bare shell and drops all CLI flags (tests only).
 * `KNUAF_TERM_MODEL` pins `--model` for the Claude terminal (tests only; unset in normal use).
 */
import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
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

/** Recovery log cap. A long thesis session must not fill the student's folder. */
const LOG_LIMIT = 8 * 1024 * 1024

/**
 * CLI flags for an agent terminal. Pure, so the composed argv is testable.
 *
 * `--setting-sources project,local` keeps the project's own skill copy authoritative:
 * a stale `~/.claude/skills/knuaf-doc` must not shadow or mix with the one the app
 * installs into the working folder. `chat/claude.ts` runs the same skill through the
 * SDK and pins the same scope for the same reason.
 *
 * `AskUserQuestion` is denied because the interview contract requires questions as
 * chat text the student can answer in their own words, not as a popup of options.
 */
export function agentArgs(kind: TermKind, opts: { resume?: boolean; revision: number | null; model?: string; shell?: boolean }): string[] {
  if (opts.shell || kind !== 'claude') return []
  return [
    '--setting-sources', 'project,local',
    '--disallowedTools', 'AskUserQuestion',
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.resume ? ['--continue'] : [firstPromptFor(opts.revision)])
  ]
}

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
  logStream: WriteStream | null
  logBytes: number
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
    const args = agentArgs(kind, {
      resume: opts.resume, revision: opts.revision, model: env.KNUAF_TERM_MODEL, shell: !!shell
    })

    const venv = this.opts.venvPython(root)
    const bundled = this.opts.bundledPython?.() ?? null
    env.PATH = [...agentBinDirs({ venvBin: venv ? dirname(venv) : null, bundledBin: bundled ? dirname(bundled) : null }), join(env.HOME ?? '', '.local', 'bin'), env.PATH ?? ''].filter(Boolean).join(':')
    env.KNUAF_DOC_APP = '1'
    env.TERM = 'xterm-256color'
    if (!env.LANG) env.LANG = 'ko_KR.UTF-8'

    // Everything that can fail happens before the pty exists: a throw after spawn
    // would leave a live agent process that closeAll() never sees.
    const log = join(root, '.knuaf-gui', `terminal-${kind}.log`)
    mkdirSync(dirname(log), { recursive: true })

    const proc = pty.spawn(binary, args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: root, env })
    const session: Session = {
      info: { id: randomUUID(), root, kind, alive: true, pid: proc.pid },
      proc,
      buffer: '',
      log,
      logStream: null,
      logBytes: 0
    }
    // A stream, not appendFileSync: the old version did a synchronous disk write on
    // the main process for every pty chunk, which blocks IPC and the window while a
    // chatty agent is talking.
    try {
      session.logStream = createWriteStream(log, { flags: 'a', mode: 0o600 })
      session.logStream.on('error', () => { session.logStream = null })
    } catch { /* the recovery log is best-effort; the terminal still works */ }

    proc.onData((data) => {
      session.buffer = (session.buffer + data).slice(-BUFFER_LIMIT)
      this.lastOutputAt.set(root, Date.now())
      this.appendLog(session, data)
      this.opts.emit('term:data', { id: session.info.id, data })
    })
    proc.onExit(({ exitCode }) => {
      session.info.alive = false
      session.info.exitCode = exitCode
      session.logStream?.end()
      session.logStream = null
      this.opts.emit('term:exit', { id: session.info.id, exitCode })
    })
    this.sessions.set(key, session)
    return { ...session.info }
  }

  /** Best-effort recovery log. Never let a write fault kill the pty callback. */
  private appendLog(session: Session, data: string): void {
    if (!session.logStream || session.logBytes >= LOG_LIMIT) return
    const text = stripAnsi(data)
    if (!text) return
    try {
      session.logStream.write(text)
      session.logBytes += Buffer.byteLength(text)
      if (session.logBytes >= LOG_LIMIT) {
        session.logStream.write('\n[기록 한도에 도달해 이후 출력은 저장하지 않습니다]\n')
        session.logStream.end()
        session.logStream = null
      }
    } catch {
      session.logStream = null  // folder removed mid-session, disk full, …
    }
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
      s.logStream?.end()
      s.logStream = null
    }
    this.sessions.clear()
    this.lastOutputAt.clear()
  }
}
