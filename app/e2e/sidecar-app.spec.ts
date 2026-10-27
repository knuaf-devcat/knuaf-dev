import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, navTo, openProject, python, synthProject } from './helpers'

for (const recovery of ['retry_stop', 'external_cleanup'] as const) {
  test(`설정은 종료 오류를 버리지 않고 ${recovery} 복구 조작을 알린다`, async () => {
    const { electronApp, page } = await launch()
    try {
      await navTo(page, '설정')
      const pythonCard = page.locator('section.card', { has: page.getByRole('heading', { name: 'Python 실행기', exact: true }) })
      await pythonCard.locator('summary').filter({ hasText: '고급' }).click()
      await electronApp.evaluate(({ ipcMain }, recovery) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
        const real = handlers.get('sidecar:restart')!
        const gate = Promise.withResolvers<void>()
        const state = globalThis as typeof globalThis & { finishStopFailure?: () => void }
        state.finishStopFailure = gate.resolve
        let first = true
        ipcMain.removeHandler('sidecar:restart')
        ipcMain.handle('sidecar:restart', async (...args: unknown[]) => {
          if (!first) return real(...args)
          first = false
          await gate.promise
          return { error: { code: 'sidecar_stop_timeout', message: 'controlled shutdown deadline', data: { recovery } } }
        })
      }, recovery)
      const restart = pythonCard.getByRole('button', { name: '적용·재시작', exact: true })
      await restart.click()
      await expect(restart).toBeDisabled()
      await electronApp.evaluate(() => {
        const state = globalThis as typeof globalThis & { finishStopFailure?: () => void }
        state.finishStopFailure!()
      })
      const error = pythonCard.getByRole('alert')
      await expect(error).toBeVisible()
      await expect(restart).toBeEnabled()
      if (recovery === 'retry_stop') {
        await expect(error).toContainText('종료를 다시 시도')
        await expect(error).not.toContainText('컴퓨터를 다시 시작')
      } else {
        await expect(error).toContainText('컴퓨터를 다시 시작')
        await expect(error).toContainText('앱만 다시 켜서는')
        await expect(error).not.toContainText('종료를 다시 시도')
      }
      await restart.click() // successful real restart clears the failed action, not just its raw text
      await expect(restart).toBeEnabled()
      await expect(error).toHaveCount(0)
      expect((await page.evaluate(() => window.knuaf.sidecarInfo())).running).toBe(true)
    } finally { await electronApp.close() }
  })
}

test('실제 Python 시작·동시 폴더 열기·재시작·앱 종료 뒤 모든 소유 PID가 정리된다', async () => {
  test.skip(process.platform === 'win32', 'POSIX wrapper; Windows launcher/base는 통합 설치본 실기기 확인')
  const dir = mkdtempSync(join(tmpdir(), 'kd-sidecar-app-'))
  const pidsFile = join(dir, 'pids.txt')
  const wrapper = join(dir, 'python')
  const program = join(dir, 'run.py')
  writeFileSync(program, `import os, runpy, sys\nsys.path.insert(0, os.getcwd())\nwith open(${JSON.stringify(pidsFile)}, 'a') as f: f.write(str(os.getpid()) + '\\n')\nsys.argv = sys.argv[2:]\nrunpy.run_module('knuaf_sidecar', run_name='__main__')\n`)
  writeFileSync(wrapper, `#!/bin/sh\nexec '${python}' '${program}' "$@"\n`, { mode: 0o755 })
  const root = synthProject()
  const { electronApp, page } = await launch({ env: { KNUAF_PYTHON: wrapper } })
  let closed = false
  const pids = () => readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number)
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  try {
    await openProject(page, root)
    const initial = pids()
    expect(initial).toHaveLength(1)
    expect(alive(initial[0])).toBe(true)
    const concurrent = await page.evaluate(async root => Promise.all([
      window.knuaf.openProject(root), window.knuaf.openProject(root)
    ]), root)
    expect(concurrent.every(result => !result.error)).toBe(true)
    expect(pids()).toEqual(initial)
    const restarted = await page.evaluate(() => window.knuaf.sidecarRestart())
    expect(restarted.result?.running).toBe(true)
    const after = pids()
    expect(after).toHaveLength(2)
    expect(alive(after[0])).toBe(false)
    expect(alive(after[1])).toBe(true)
    const hello = await page.evaluate(() => window.knuaf.call('sys.hello', {}))
    expect(hello.error).toBeUndefined()
    expect(hello.result).toMatchObject({ interpreter_kind: 'env' })
    await electronApp.close(); closed = true
    expect(after.filter(alive)).toEqual([])
  } finally {
    if (!closed) await electronApp.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const phase of ['ready', 'methods.list'] as const) {
  test(`F-IMPL-01 실제 Electron 종료는 ${phase} 무응답 Python을 중단·정리한다`, async () => {
    test.skip(process.platform === 'win32', 'POSIX wrapper; Windows 실기기 판정 아님')
    const dir = mkdtempSync(join(tmpdir(), 'kd-sidecar-stalled-'))
    const pidFile = join(dir, 'phase.pid')
    const program = join(dir, 'stall.py')
    const wrapper = join(dir, 'python')
    const waitForMethods = phase === 'methods.list'
      ? `print('{\"event\":\"ready\",\"data\":{}}', flush=True)\nrequest = json.loads(sys.stdin.readline())\nassert request['method'] == 'methods.list'\n`
      : ''
    writeFileSync(program, `import json, os, sys, time\n${waitForMethods}with open(${JSON.stringify(pidFile)}, 'w') as f: f.write(str(os.getpid()))\ntime.sleep(120)\n`)
    writeFileSync(wrapper, `#!/bin/sh\nexec '${python}' '${program}' \"$@\"\n`, { mode: 0o755 })
    const { electronApp, page } = await launch({ env: { KNUAF_PYTHON: wrapper } })
    let closed = false
    let pid: number | null = null
    try {
      await page.evaluate(root => { void window.knuaf.openProject(root) }, dir)
      await expect.poll(() => existsSync(pidFile), { timeout: 5000 }).toBe(true)
      pid = Number(readFileSync(pidFile, 'utf8'))
      const before = Date.now()
      const quit = electronApp.waitForEvent('close', { timeout: 7000 })
      await electronApp.evaluate(({ app }) => { setTimeout(() => app.quit(), 0) })
      await quit; closed = true
      const elapsed = Date.now() - before
      console.log(`F-IMPL-01 ${phase}: app quit in ${elapsed}ms; owned pid ${pid}`)
      expect(elapsed).toBeLessThan(6500)
      let alive = false
      try { process.kill(pid, 0); alive = true } catch { /* expected: owned process was reaped */ }
      expect(alive).toBe(false)
    } finally {
      if (!closed) await electronApp.close()
      if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* already reaped */ } }
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
