export const SWITCH_MESSAGE = '규칙집을 바꾸는 중이에요. 잠시 뒤 다시 시도해 주세요.'
export class SkillSwitch {
  private locked = false
  private running = 0
  private idle = new Set<() => void>()
  get switching(): boolean { return this.locked }
  enter(): () => void {
    if (this.locked) throw new Error(SWITCH_MESSAGE)
    ++this.running
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.running === 0) for (const resolve of this.idle) resolve()
    }
  }
  async run<T>(work: () => Promise<T>): Promise<T> { const release = this.enter(); try { return await work() } finally { release() } }
  async switch<T>(work: () => Promise<T>, timeout = 30_000): Promise<T> {
    if (this.locked) throw new Error(SWITCH_MESSAGE)
    this.locked = true
    try {
      if (this.running) {
        const { promise, resolve, reject } = Promise.withResolvers<void>()
        const done = (): void => { clearTimeout(timer); this.idle.delete(done); resolve() }
        const timer = setTimeout(() => { this.idle.delete(done); reject(new Error('작업이 끝난 뒤 다시 눌러 주세요.')) }, timeout)
        this.idle.add(done)
        await promise
      }
      return await work()
    } finally { this.locked = false }
  }
}
export const skillSwitch = new SkillSwitch()
