import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { RpcError, SidecarInfo } from '../shared/types'
import { choosePython, scriptsDir, sidecarDir } from './python'
import { skillSwitch } from './update/switch'
import { agentActivity } from './update/activity'

type Pending = { resolve: (v: unknown) => void; reject: (e: RpcError) => void; onEvent?: (event: string, data: unknown) => void }
type OwnedProcess = {
  child: ChildProcessWithoutNullStreams
  exited: boolean
  closed: boolean
  stopping: boolean
  tree: 'normal' | 'pending' | 'confirmed' | 'failed'
  failure: RpcError | null
}
const START_CANCELLED: RpcError = { code: 'sidecar_start_cancelled', message: 'sidecar startup interrupted by stop' }

/** Owns one sidecar until both its process and stdio have closed. */
export class Sidecar extends EventEmitter {
  private owner: OwnedProcess | null = null
  private pending = new Map<string, Pending>()
  private seq = 0
  private info: SidecarInfo = { python: '', kind: 'path', scriptsDir: scriptsDir(), running: false }
  private projectRoot: string | null = null
  private override: string | null = null
  private lifecycle: Promise<void> = Promise.resolve()
  private writeMethods = new Set<string>()
  private stopVersion = 0
  private abortStart: ((error: RpcError) => void) | null = null
  private shutdown: Promise<void> | null = null

  status(): SidecarInfo {
    return { ...this.info, running: this.info.running && !!this.owner && !this.owner.exited && !this.owner.stopping }
  }

  /** Whether `method` mutates the project. Unknown/older sidecars report nothing → reads only. */
  isWrite(method: string): boolean { return this.writeMethods.has(method) }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation)
    // Preserve this caller's failure without poisoning subsequent lifecycle operations.
    this.lifecycle = result.then(() => undefined, () => undefined)
    return result
  }

  configure(projectRoot: string | null, override: string | null): Promise<SidecarInfo> {
    const version = this.stopVersion
    return agentActivity.run(() => skillSwitch.run(() => this.enqueue(() => this.configureNow(projectRoot, override, version))))
  }

  restart(): Promise<SidecarInfo> {
    const version = this.stopVersion
    return this.enqueue(async () => {
      if (version !== this.stopVersion) throw START_CANCELLED
      await this.stopNow() // Explicit restart may retry stopping the same live, quarantined process.
      return this.configureNow(this.projectRoot, this.override, version)
    })
  }

  stop(): Promise<void> {
    ++this.stopVersion // Also cancel starts queued before this stop, not only the active startup.
    this.abortStart?.(START_CANCELLED)
    const stopped = this.stopNow() // Start the bounded shutdown immediately, outside the blocked queue.
    return this.enqueue(() => stopped)
  }

  private async configureNow(projectRoot: string | null, override: string | null, version: number): Promise<SidecarInfo> {
    if (version !== this.stopVersion) throw START_CANCELLED
    this.projectRoot = projectRoot
    this.override = override
    if (this.owner?.failure) throw this.stopFailure(this.owner)
    const pick = choosePython(projectRoot, override)
    const scripts = scriptsDir()
    if (this.status().running && pick.python === this.info.python && scripts === this.info.scriptsDir) return this.status()
    await this.stopNow()
    if (version !== this.stopVersion) throw START_CANCELLED
    this.info = { ...pick, scriptsDir: scripts, running: false }
    const interrupted = Promise.withResolvers<never>()
    let startupError: RpcError | null = null
    const abort = (error: RpcError): void => { startupError = error; interrupted.reject(error) }
    this.abortStart = abort
    // One deadline covers both ready and methods.list; neither phase may pin the queue.
    const timer = setTimeout(() => abort({ code: 'sidecar_start_timeout', message: 'sidecar ready/methods.list timed out after 10000ms' }), 10000)
    try {
      await Promise.race([this.startNow(), interrupted.promise])
      try {
        // Internal calls must not wait for the lifecycle operation they belong to.
        const list = await Promise.race([this.sendCall<{ name: string; write: boolean }[]>('methods.list'), interrupted.promise])
        this.writeMethods = new Set(list.filter((m) => m.write).map((m) => m.name))
      } catch (error) {
        if (startupError) throw error
        this.writeMethods.clear()
      }
      if (!this.status().running) throw { code: 'sidecar_exited', message: 'sidecar exited during startup' }
      return this.status()
    } catch (error) {
      // An explicit stop already owns cleanup; do not retry its failure or extend its deadline.
      if (version === this.stopVersion) await this.stopNow()
      throw error
    } finally {
      clearTimeout(timer)
      if (this.abortStart === abort) this.abortStart = null
    }
  }

  private rejectPending(error: RpcError): void {
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
  }

  private release(owner: OwnedProcess): void {
    if (this.owner !== owner || !owner.closed || owner.tree === 'pending' || owner.tree === 'failed') return
    this.owner = null
    this.info.running = false
  }

  private startNow(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const args = ['-m', 'knuaf_sidecar', '--scripts-dir', this.info.scriptsDir, '--interpreter-kind', this.info.kind]
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(this.info.python, args, { cwd: sidecarDir(), env, windowsHide: true })
    } catch (error) {
      reject({ code: 'spawn_failed', message: String(error) })
      return promise
    }
    const owner: OwnedProcess = { child: proc, exited: false, closed: false, stopping: false, tree: 'normal', failure: null }
    this.owner = owner
    let settled = false
    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      if (this.owner !== owner || owner.stopping) return
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
    createInterface({ input: proc.stderr }).on('line', (line) => {
      if (this.owner === owner) this.emit('log', { stream: 'stderr', line })
    })
    proc.on('exit', (code, signal) => {
      owner.exited = true
      if (this.owner !== owner) return
      this.info.running = false
      this.writeMethods.clear()
      const err: RpcError = { code: 'sidecar_exited', message: `sidecar exited (${code ?? signal})` }
      this.rejectPending(err)
      if (!settled) { settled = true; reject(err) }
      this.emit('exit', { code, signal })
    })
    proc.on('close', () => {
      owner.closed = true
      this.release(owner)
    })
    proc.on('error', (error) => {
      if (this.owner !== owner) return
      this.info.running = false
      const err: RpcError = { code: 'spawn_failed', message: String(error) }
      this.rejectPending(err)
      if (!settled) { settled = true; reject(err) }
    })
    proc.stdin.on('error', (error) => {
      if (this.owner !== owner || owner.stopping) return
      this.info.running = false
      this.rejectPending({ code: 'sidecar_exited', message: String(error) })
    })
    return promise
  }

  /** `onId` receives the request id right after it is minted, for cancellation. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, onEvent?: Pending['onEvent'], onId?: (id: string) => void): Promise<T> {
    return agentActivity.run(() => skillSwitch.run(async () => {
      await this.lifecycle
      return this.sendCall<T>(method, params, onEvent, onId)
    }))
  }

  private async sendCall<T>(method: string, params: Record<string, unknown> = {}, onEvent?: Pending['onEvent'], onId?: (id: string) => void): Promise<T> {
    if (this.owner?.failure) throw this.stopFailure(this.owner)
    if (!this.status().running) throw { code: 'sidecar_down', message: 'Python 사이드카가 실행 중이 아님' }
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const id = `m${++this.seq}`
    onId?.(id)
    this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onEvent })
    const failed = (error: Error): void => {
      this.pending.delete(id)
      reject({ code: 'sidecar_exited', message: String(error) })
    }
    try {
      this.owner!.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => { if (error) failed(error) })
    } catch (error) { failed(error as Error) }
    return promise
  }

  cancel(id: string): void {
    if (this.status().running) this.owner!.child.stdin.write(JSON.stringify({ id: `c${++this.seq}`, method: 'cancel', params: { id } }) + '\n')
  }

  private stopFailure(owner: OwnedProcess): RpcError {
    return {
      ...owner.failure!,
      data: { pid: owner.child.pid, recovery: !owner.exited && !owner.closed ? 'retry_stop' : 'external_cleanup' }
    }
  }

  private stopNow(): Promise<void> {
    if (this.shutdown) return this.shutdown
    const result = this.stopOwnedNow()
    this.shutdown = result
    const clear = (): void => { if (this.shutdown === result) this.shutdown = null }
    void result.then(clear, clear)
    return result
  }

  /** Bounded shutdown; neither exit alone nor a timeout transfers ownership. */
  private async stopOwnedNow(): Promise<void> {
    const owner = this.owner
    if (!owner) return
    if (owner.failure && (owner.exited || owner.closed)) throw this.stopFailure(owner)
    const proc = owner.child
    owner.stopping = true
    this.info.running = false
    this.writeMethods.clear()
    this.rejectPending({ code: 'sidecar_exited', message: 'sidecar is stopping' })
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    let killer: ChildProcess | null = null
    let finished = false
    const finish = (error?: RpcError): void => {
      if (finished) return
      finished = true
      clearTimeout(grace)
      clearTimeout(deadline)
      proc.removeListener('close', onClose)
      if (error) {
        owner.failure = error
        reject(this.stopFailure(owner))
      } else {
        owner.failure = null
        this.release(owner)
        resolve()
      }
    }
    const onClose = (): void => {
      if (owner.closed && owner.tree !== 'pending' && owner.tree !== 'failed') finish()
    }
    const grace = setTimeout(() => {
      // An exited launcher PID may be reused; never target it to find lost children.
      if (owner.exited || !proc.pid) return
      if (process.platform !== 'win32') {
        try {
          if (!proc.kill('SIGKILL')) finish({ code: 'sidecar_stop_failed', message: 'sidecar kill was not accepted' })
        } catch (error) { finish({ code: 'sidecar_stop_failed', message: String(error) }) }
        return
      }
      owner.tree = 'pending'
      const failed = (message: string): void => {
        owner.tree = 'failed'
        finish({ code: 'sidecar_stop_failed', message })
      }
      try {
        const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
        killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
        killer.once('error', (error) => { if (!finished) failed(String(error)) })
        killer.once('exit', (code) => {
          if (finished) return
          if (code !== 0) { failed(`taskkill exited (${code})`); return }
          owner.tree = 'confirmed'
          this.release(owner)
          onClose()
        })
      } catch (error) { failed(String(error)) }
    }, 3000)
    const deadline = setTimeout(() => {
      if (owner.tree === 'pending') owner.tree = 'failed'
      finish({ code: 'sidecar_stop_timeout', message: 'sidecar shutdown was not confirmed within 6000ms' })
      try { killer?.kill('SIGKILL') } catch { /* original sidecar ownership remains quarantined */ }
    }, 6000)
    proc.on('close', onClose)
    try { proc.stdin.write(JSON.stringify({ id: 'bye', method: 'shutdown' }) + '\n') } catch { /* close/deadline decides */ }
    onClose()
    return promise
  }
}
