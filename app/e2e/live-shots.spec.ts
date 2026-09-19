// Captures the live "내 논문" screen for review: the Codex chat tab and the Claude tab
// with the real `claude` CLI (this machine is logged in via claude.ai). Artifacts only.
import { expect, test } from '@playwright/test'
import { launch, openProject, synthProject } from './helpers'

test('live shots: codex chat + real claude terminal', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('.chat-seg')).toBeVisible()
    await expect.poll(async () => {
      const s = await page.evaluate(async (r) => {
        const r_ = await window.knuaf.chat.status(r, 'codex')
        return 'result' in r_ ? r_.result : null
      }, root)
      return s?.installed
    }).toBe(true)
    await page.waitForTimeout(1500)
    await page.screenshot({ path: 'e2e/artifacts/live-codex.png' })

    await page.click('button[role="tab"]:has-text("Claude (터미널)")')
    await expect(page.locator('.term-host .xterm')).toBeVisible()
    await page.waitForTimeout(20_000) // real claude TUI startup + first prompt
    await page.screenshot({ path: 'e2e/artifacts/live-claude.png' })
  } finally {
    await electronApp.close()
  }
})
