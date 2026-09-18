import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import type { RpcError, SidecarInfo } from '../shared/types'
import { choosePython, scriptsDir, sidecarDir } from './python'

type Pending = { resolve: (v: unknown) => void; reject: (e: RpcError) => void; onEvent?: (event: string, data: unknown) => void }

/** One Python sidecar process speaking JSON-lines. Restarted when the interpreter changes. */
export class Sidecar extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, Pending>()
  private seq = 0
  private info: SidecarInfo = { python: '', kind: 'path', scriptsDir: scriptsDir(), running: false }
  private projectRoot: string | null = null
  private override: string | null = null
  private ready: Promise<void> = Promise.resolve()

  status(): SidecarInfo { return { ...this.info, running: this.proc !== null } }

  /** (Re)start for a project root; restarts only when the chosen interpreter changed. */
  async configure(projectRoot: string | null, override: string | null): Promise<SidecarInfo> {
    this.projectRoot = projectRoot
    this.override = override
    const pick = choosePython(projectRoot, override)
    if (this.proc && pick.python === this.info.python) return this.status()
    await this.stop()
    this.info = { ...pick, scriptsDir: scriptsDir(), running: false }
    this.ready = this.start()
    await this.ready
    return this.status()
  }

  async restart(): Promise<SidecarInfo> {
    await this.stop()
    return this.configure(this.projectRoot, this.override)
  }

  private start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['-m', 'knuaf_sidecar', '--scripts-dir', this.info.scriptsDir, '--interpreter-kind', this.info.kind]
      const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }
      let proc: ChildProcessWithoutNullStreams
      try {
        proc = spawn(this.info.python, args, { cwd: sidecarDir(), env, windowsHide: true })
      } catch (error) {
        reject({ code: 'spawn_failed', message: String(error) })
        return
      }
      this.proc = proc
      let settled = false
      const rl = createInterface({ input: proc.stdout })
      rl.on('line', (line) => {
        let msg: { id?: string | null; result?: unknown; error?: RpcError; event?: string; data?: unknown }
        try { msg = JSON.parse(line) } catch { this.emit('log', { stream: 'stdout', line }); return }
        if (msg.event === 'ready' && !settled) { settled = true; this.info.running = true; resolve(); this.emit('ready', msg.data); return }
        if (msg.id == null && msg.error && !settled) { settled = true; reject(msg.error); return }
        const p = msg.id != null ? this.pending.get(msg.id) : undefined
        if (!p) { this.emit('log', { stream: 'stdout', line }); return }
        if (msg.event) { p.onEvent?.(msg.event, msg.data); this.emit('event', { id: msg.id, event: msg.event, data: msg.data }); return }
        this.pending.delete(msg.id as string)
        if (msg.error) p.reject(msg.error); else p.resolve(msg.result)
      })
      createInterface({ input: proc.stderr }).on('line', (line) => this.emit('log', { stream: 'stderr', line }))
      proc.on('exit', (code, signal) => {
        this.proc = null
        this.info.running = false
        const err: RpcError = { code: 'sidecar_exited', message: `sidecar exited (${code ?? signal})` }
        for (const p of this.pending.values()) p.reject(err)
        this.pending.clear()
        if (!settled) { settled = true; reject(err) }
        this.emit('exit', { code, signal })
      })
      proc.on('error', (error) => {
        if (!settled) { settled = true; reject({ code: 'spawn_failed', message: String(error) }) }
      })
    })
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, onEvent?: Pending['onEvent']): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.proc) { reject({ code: 'sidecar_down', message: 'Python 사이드카가 실행 중이 아님' }); return }
      const id = `m${++this.seq}`
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onEvent })
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  cancel(id: string): void { this.proc?.stdin.write(JSON.stringify({ id: `c${++this.seq}`, method: 'cancel', params: { id } }) + '\n') }

  async stop(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.proc = null
    try { proc.stdin.write(JSON.stringify({ id: 'bye', method: 'shutdown' }) + '\n') } catch { /* already gone */ }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { proc.kill() } catch { /* ignore */ } resolve() }, 3000)
      proc.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
}
