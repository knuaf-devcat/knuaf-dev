import { test, expect } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { launch, openProject, plantStaleLock, synthProject } from './helpers'
import { writeCliShim } from './fixtures/fake-codex'

// 도우미 채팅 실행 중에는 sidecar 쓰기가 거절된다 — 동시 쓰기는 도우미의 저장과 경합한다.
// 실행 중 상태는 핸드셰이크에 응답하지 않는 가짜 codex로 만든다 — send() 가 acquire 한
// 뒤 status() 에서 멈추는 동안 busy 가 잡힌다.
test('a running chat turn rejects sidecar writes with agent_busy, then recovers', async () => {
  const bindir = mkdtempSync(join(tmpdir(), 'kd-bin-'))
  // 핸드셰이크에 응답하지 않는 가짜 codex — **절대 경로 node** 로 살아만 있는다.
  // 이 시험은 PATH 를 좁히므로(system32 없음) `ping` 같은 셸 도구에 기대면 윈도우에서
  // 즉시 죽어 busy 가 잡히지 않는다(CI 3차).
  writeCliShim(bindir, 'codex', 'sleep 300', `"${process.execPath}" -e "setInterval(()=>{},1000)"`)
  const root = synthProject({ withContent: false })
  plantStaleLock(root) // gives lock.unlock something real to release on the second attempt
  const { electronApp, page } = await launch({ env: { PATH: [bindir, '/usr/bin', '/bin'].join(delimiter) } })
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })

    // send() 는 가짜 서버의 initialize 응답을 영원히 기다린다 — 그동안 owner 를 쥔다.
    void page.evaluate((r) => window.knuaf.chat.send(r, 'codex', '홀드', crypto.randomUUID()), root).catch(() => {})
    await expect.poll(async () => {
      const r = await page.evaluate((r) => window.knuaf.call('lock.unlock', { root: r }), root)
      return 'error' in r ? r.error.code : 'no-error'
    }, { timeout: 15_000 }).toBe('agent_busy')

    // reads are never gated
    const read = await page.evaluate((r) => window.knuaf.call('project.status', { root: r }), root)
    expect('error' in read ? read.error : null).toBeNull()

    // 멈춘 연결을 끊으면 owner 가 풀리고 같은 쓰기가 sidecar 에 도달한다.
    // stop() 은 응답 없는 프로세스를 죽이고, 진행 중인 연결 재시도도 함께 끊는다.
    await page.evaluate((r) => window.knuaf.chat.stop(r, 'codex'), root)
    await expect.poll(async () => {
      const r = await page.evaluate((r) => window.knuaf.call('lock.unlock', { root: r }), root)
      return 'error' in r ? r.error.code : 'ok'
    }, { timeout: 15_000 }).toBe('ok')
  } finally {
    await electronApp.close()
  }
})

test('종료 시작 뒤 늦은 상태 조회가 연결이나 Codex를 되살리지 않는다', async () => {
  const bindir = mkdtempSync(join(tmpdir(), 'kd-quit-bin-'))
  const starts = join(bindir, 'starts.txt')
  const script = join(bindir, 'hold.cjs')
  writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(starts)}, process.cwd() + '\\n'); setInterval(() => {}, 1000)\n`)
  writeCliShim(bindir, 'codex', `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, `"${process.execPath}" "${script}"`)
  const root = synthProject({ withContent: false })
  const other = synthProject({ withContent: false })
  const { electronApp, page } = await launch({ env: { PATH: [bindir, '/usr/bin', '/bin'].join(delimiter), KNUAF_AGENT_PATH_ONLY: '1' } })
  let closed = false
  try {
    await openProject(page, root)
    await expect.poll(() => existsSync(starts) ? readFileSync(starts, 'utf8') : '', { timeout: 30000 }).toContain('connect-probe')
    await expect.poll(() => readFileSync(starts, 'utf8'), { timeout: 30000 }).toContain(root)
    await electronApp.evaluate(({ app, ipcMain }, file) => {
      const fs = process.getBuiltinModule('node:fs')!
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const state = { quitting: false, release: false, calls: [] as string[], before: '' }
      Object.assign(globalThis, { quitProbe: state })
      for (const channel of ['chat:status', 'connect:status']) {
        const original = handlers.get(channel)!
        handlers.set(channel, (...args) => {
          if (state.quitting) state.calls.push(channel)
          return original(...args)
        })
      }
      app.prependListener('before-quit', () => {
        if (!state.quitting) state.before = fs.readFileSync(file, 'utf8')
        state.quitting = true
      })
      // 앱이 창을 닫기 전에 명시적 IPC 결과를 확인한다. 해제 뒤 실제 종료는 그대로 진행한다.
      app.on('before-quit', (e) => { if (!state.release) e.preventDefault() })
    }, starts)
    await page.evaluate(({ root, other }) => {
      window.knuaf.onAppQuitting(() => {
        void Promise.all([
          window.knuaf.chat.status(root, 'codex'),
          window.knuaf.chat.status(other, 'codex'),
          window.knuaf.connect.status('codex')
        ]).then((results) => { Object.assign(window, { quitProbeResults: results }) })
      })
    }, { root, other })
    await electronApp.evaluate(({ app }) => { setImmediate(() => app.quit()) })
    await page.waitForFunction(() => Array.isArray(Reflect.get(window, 'quitProbeResults')))
    const results = await page.evaluate(() => Reflect.get(window, 'quitProbeResults')) as { error?: { message: string } }[]
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.error?.message.includes('앱을 종료하고 있어요'))).toBe(true)
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('확인 실패', { timeout: 30000 })
    const state = await electronApp.evaluate(() => Reflect.get(globalThis, 'quitProbe')) as { calls: string[]; before: string }
    expect(state.calls.filter((c) => c === 'chat:status')).toHaveLength(2)
    expect(state.calls.filter((c) => c === 'connect:status')).toHaveLength(1)
    expect(readFileSync(starts, 'utf8')).toBe(state.before)
    await electronApp.evaluate(() => { Reflect.get(globalThis, 'quitProbe').release = true })
    await electronApp.close(); closed = true
    expect(readFileSync(starts, 'utf8')).toBe(state.before)
  } finally {
    if (!closed) {
      await electronApp.evaluate(() => { const state = Reflect.get(globalThis, 'quitProbe'); if (state) state.release = true })
      await electronApp.close()
    }
  }
})
