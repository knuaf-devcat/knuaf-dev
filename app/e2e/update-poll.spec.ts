import { expect, test } from '@playwright/test'
import { startPoll, stopPoll, useConnect } from '../src/renderer/src/store/connect'
import { UPDATE_RECOVERY_COPY } from '../src/shared/copy'

test('suspended probes obey stop, restart and the three-minute deadline', async () => {
  const original = { setInterval, clearInterval, setTimeout, clearTimeout, window: (globalThis as { window?: unknown }).window }
  const originalState = useConnect.getState()
  let now = 0, next = 0, calls = 0
  const timers = new Map<number, { at: number; delay: number; repeat: boolean; fn: () => void }>()
  const schedule = (fn: () => void, delay: number, repeat: boolean) => {
    const id = ++next; timers.set(id, { at: now + delay, delay, repeat, fn }); return id
  }
  globalThis.setInterval = ((fn: () => void, delay: number) => schedule(fn, delay, true)) as unknown as typeof setInterval
  globalThis.setTimeout = ((fn: () => void, delay: number) => schedule(fn, delay, false)) as unknown as typeof setTimeout
  globalThis.clearInterval = ((id: number) => { timers.delete(id) }) as unknown as typeof clearInterval
  globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as unknown as typeof clearTimeout
  ;(globalThis as { window?: unknown }).window = { knuaf: { connect: { status: async () => {
    calls++; return { error: { code: 'update_suspended', message: UPDATE_RECOVERY_COPY } }
  } } } }
  const advance = async (ms: number) => {
    const end = now + ms
    while (true) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, timer] = due; now = timer.at
      if (timer.repeat) timer.at += timer.delay; else timers.delete(id)
      timer.fn()
      for (let i = 0; i < 12; i++) await Promise.resolve()
    }
    now = end
  }
  const tick = async () => { await useConnect.getState().refresh('codex'); return false }
  try {
    useConnect.setState({ loggingIn: { codex: true, claude: false } })
    startPoll('codex', tick)
    await advance(6000)
    expect(calls).toBe(2)
    expect(useConnect.getState().codex).toMatchObject({ state: 'unknown', detail: UPDATE_RECOVERY_COPY })
    expect(useConnect.getState().loggingIn.codex).toBe(false)
    stopPoll('codex')
    await advance(5000)
    expect(calls).toBe(2); expect(timers.size).toBe(0)
    startPoll('codex', tick)
    await advance(3000)
    expect(calls).toBe(3)
    startPoll('codex', tick)
    await advance(6000)
    expect(calls).toBe(5)
    await advance(174000)
    expect(calls).toBe(63)
    expect(timers.size).toBe(0)
    const stoppedAt = calls
    await advance(5000)
    expect(calls).toBe(stoppedAt)
    // A replaced poll must not overlap an already in-flight request.
    let release: (done: boolean) => void = () => {}
    let overlap = 0
    startPoll('codex', () => new Promise<boolean>(resolve => { release = resolve }))
    await advance(3000)
    startPoll('codex', async () => { overlap++; return false })
    await advance(6000)
    expect(overlap).toBe(0)
    release(false)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    await advance(3000)
    expect(overlap).toBe(1)
    // A stuck in-flight tick must not prevent the independent deadline from clearing timers.
    startPoll('codex', () => new Promise<boolean>(() => {}))
    await advance(180000)
    expect(timers.size).toBe(0)
  } finally {
    stopPoll()
    useConnect.setState(originalState)
    globalThis.setInterval = original.setInterval; globalThis.clearInterval = original.clearInterval
    globalThis.setTimeout = original.setTimeout; globalThis.clearTimeout = original.clearTimeout
    ;(globalThis as { window?: unknown }).window = original.window
  }
})
