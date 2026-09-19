import { test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'

// Real composited captures (vibrancy, traffic lights) via screencapture. Needs Screen Recording
// permission for the launching app; when it is missing the files are still written (desktop only).
const OUT = resolve(__dirname, '..', '..', 'docs', 'images', 'window')
test.skip(process.platform !== 'darwin', 'macOS only')

for (const scheme of ['light', 'dark'] as const) {
  test(`real window capture (${scheme})`, async () => {
    mkdirSync(OUT, { recursive: true })
    const root = synthProject()
    const { electronApp, page } = await launch({ colorScheme: scheme })
    await openProject(page, root)
    await page.waitForSelector('h1:has-text("내 논문")', { timeout: 30_000 })
    await navTo(page, '대시보드')
    await page.waitForSelector('h1:has-text("대시보드")', { timeout: 30_000 })
    await page.waitForTimeout(800)
    const b = await electronApp.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.focus(); return w.getBounds() })
    const file = `${OUT}/dashboard-${scheme}.png`
    execFileSync('screencapture', ['-x', '-R', `${b.x},${b.y},${b.width},${b.height}`, file])
    console.log('captured', file, statSync(file).size, 'bytes')
    await electronApp.close()
  })
}
