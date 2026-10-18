// Captures the live "내 논문" screen for review: codex chat + claude chat (SDK),
// this machine is logged in to both. Artifacts only.
import { expect, test } from '@playwright/test'
import { launch, openProject, synthProject } from './helpers'

test('live shots: codex chat + claude chat', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    await expect.poll(async () => {
      const s = await page.evaluate(async (r) => {
        const r_ = await window.knuaf.chat.status(r, 'codex')
        return 'result' in r_ ? r_.result : null
      }, root)
      return s?.installed
    }).toBe(true)
    await page.waitForTimeout(1500)
    await page.screenshot({ path: 'e2e/artifacts/live-codex.png' })

    // v5 는 빈 대화에서 AI 를 고르지 않는다(DESIGN §4) — 계정 팝오버에서 바꾼 뒤 [시작하기]를 누른다.
    await page.locator('.titlebar .tbtn.acct').click()
    await page.locator('.titlebar .popover').getByRole('button', { name: /Claude로 바꾸기/ }).click()
    await page.locator('.chat-empty button.primary').click()
    await expect.poll(async () => {
      const s = await page.evaluate(async (r) => {
        const r_ = await window.knuaf.chat.snapshot(r, 'claude')
        return 'result' in r_ ? r_.result : null
      }, root)
      return s?.messages.length ?? 0
    }, { timeout: 60_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(5_000) // 첫 응답이 흐르는 모습을 담는다
    await page.screenshot({ path: 'e2e/artifacts/live-claude.png' })
  } finally {
    await electronApp.close()
  }
})
