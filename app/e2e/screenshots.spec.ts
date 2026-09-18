import { test } from '@playwright/test'
import { resolve } from 'node:path'
import { launch, openProject, plantStaleLock, synthProject } from './helpers'

const OUT = resolve(__dirname, '..', '..', 'docs', 'images')
const SCREENS: [string, string][] = [['02-dashboard', '대시보드'], ['03-checks', '검사 결과'], ['04-tasks', '다음 할 일'], ['05-sections', '절 목록'], ['06-outputs', '산출물'], ['07-troubleshoot', '문제 해결'], ['08-settings', '설정']]

for (const scheme of ['light', 'dark'] as const) {
  test(`screenshots (${scheme})`, async () => {
    const root = synthProject()
    const { electronApp, page } = await launch({ colorScheme: scheme })
    await page.setViewportSize({ width: 1180, height: 800 })
    // documentation shots use the solid sidebar (vibrancy is not captured by the web layer)
    await page.evaluate(() => { document.documentElement.dataset.vibrancy = 'off' })
    const suffix = scheme === 'dark' ? '-dark' : ''
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${OUT}/01-home${suffix}.png` })
    await openProject(page, root)
    await page.waitForSelector('h1:has-text("대시보드")', { timeout: 30_000 })
    plantStaleLock(root)
    for (const [file, nav] of SCREENS) {
      await page.click(`nav >> text=${nav}`)
      await page.waitForTimeout(600)
      if (file === '07-troubleshoot') { await page.click('text=다시 진단'); await page.waitForSelector('text=남은 잠금', { timeout: 30_000 }); await page.waitForTimeout(300) }
      await page.screenshot({ path: `${OUT}/${file}${suffix}.png` })
    }
    await electronApp.close()
  })
}
