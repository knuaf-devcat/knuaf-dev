export class UpdateSuspendedError extends Error {
  readonly code = 'update_suspended'
  constructor() { super('업데이트를 준비하고 있어요. 잠시 기다려 주세요.') }
}
/** Every asynchronous agent entry (including probes, not only turns) owns a lease. */
export class AgentActivity {
  private paused = false
  private count = 0
  private idle = new Set<() => void>()
  get suspended(): boolean { return this.paused }
  suspend(): void { if (this.paused) throw new UpdateSuspendedError(); this.paused = true }
  resume(): void { this.paused = false }
  ensureActive(): void { if (this.paused) throw new UpdateSuspendedError() }
  enter(): () => void {
    this.ensureActive()
    ++this.count
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.count === 0) for (const done of this.idle) done()
    }
  }
  async run<T>(work: () => T | Promise<T>): Promise<T> {
    const release = this.enter()
    try { return await work() } finally { release() }
  }
  async drain(timeout = 30_000): Promise<void> {
    if (!this.paused) throw new Error('인계 일시 정지 없이 작업을 비울 수 없어요.')
    if (!this.count) return
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const done = (): void => { clearTimeout(timer); this.idle.delete(done); resolve() }
    const timer = setTimeout(() => { this.idle.delete(done); reject(new Error('작업이 끝난 뒤 다시 눌러 주세요.')) }, Math.max(0, timeout))
    this.idle.add(done)
    return promise
  }
}
export const agentActivity = new AgentActivity()
