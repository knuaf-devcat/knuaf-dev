import { test, expect } from '@playwright/test'
import { launch, openProject, plantStaleLock, synthProject } from './helpers'

// A live agent terminal that emitted output within the last 5 s makes the app
// refuse write RPCs — concurrent writers would race the agent's own saves.
test('terminal activity rejects sidecar writes with agent_busy, then recovers', async () => {
  const root = synthProject({ withContent: false })
  plantStaleLock(root) // gives lock.unlock something real to release on the second attempt
  const { electronApp, page } = await launch({ env: { KNUAF_TERM_SHELL: '/bin/sh' } })
  try {
    await openProject(page, root)
    await page.getByRole('heading', { name: '내 논문' }).waitFor()

    const opened = await page.evaluate(async (r) => {
      const r1 = await window.knuaf.term.open(r, 'claude', { revision: null, resume: false, cols: 80, rows: 24 })
      if ('error' in r1) throw new Error(r1.error.message)
      return r1.result
    }, root)

    // reads are never gated
    const read = await page.evaluate((r) => window.knuaf.call('project.status', { root: r }), root)
    expect('error' in read ? read.error : null).toBeNull()

    await page.evaluate((id) => window.knuaf.term.write(id, 'yes | head -c 100000\n'), opened.id)
    await expect.poll(async () => {
      const r = await page.evaluate((id) => window.knuaf.term.replay(id), opened.id)
      return 'result' in r ? r.result.length : 0
    }).toBeGreaterThan(1000)

    // fresh output → the write is refused before it reaches the sidecar
    const busy = await page.evaluate((r) => window.knuaf.call('lock.unlock', { root: r }), root)
    expect('error' in busy && busy.error.code).toBe('agent_busy')

    // after the quiet window the same write reaches the sidecar normally
    await page.waitForTimeout(6000)
    const ok = await page.evaluate((r) => window.knuaf.call('lock.unlock', { root: r }), root)
    expect('error' in ok ? ok.error : null).toBeNull()
  } finally {
    await electronApp.close()
  }
})
