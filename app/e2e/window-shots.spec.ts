import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'

// Real composited captures (vibrancy, traffic lights) via screencapture. Needs Screen Recording
// permission for the launching app; when it is missing the files are still written (desktop only).
const OUT = resolve(__dirname, '..', '..', 'docs', 'images', 'window')
test.skip(process.platform !== 'darwin', 'macOS only')

/** 지금 화면 맨 앞에 있는 앱 이름. 실패하면 빈 문자열 — poll 이 계속 기다린다. */
function frontmostApp(): string {
  try {
    return execFileSync('osascript', ['-e',
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ], { encoding: 'utf-8' }).trim()
  } catch { return '' }
}

for (const scheme of ['light', 'dark'] as const) {
  test(`real window capture (${scheme})`, async () => {
    mkdirSync(OUT, { recursive: true })
    const root = synthProject()
    const { electronApp, page } = await launch({ colorScheme: scheme })
    await openProject(page, root)
    await page.waitForSelector('h1:has-text("내 논문")', { timeout: 30_000 })
    await navTo(page, '점검')
    await page.waitForSelector('h1:has-text("점검")', { timeout: 30_000 })
    await page.waitForTimeout(800)
    const b = await electronApp.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.focus(); return w.getBounds() })
    // screencapture -R 은 창이 아니라 그 화면 '영역'을 찍는다. w.focus() 는 요청일 뿐이고
    // macOS 가 들어주지 않으면 그 자리에 있던 남의 창이 그대로 찍힌다. 이 파일들은
    // 공개 저장소에 커밋되므로, 한 번 새면 남의 화면이 공개된다(실제로 개발 중
    // 브라우저 설정 화면이 찍힌 적이 있다). 앞에 있는 앱이 우리 것이 아니면 찍지 않는다.
    await expect
      .poll(() => frontmostApp(), { timeout: 5_000, message: '앱이 맨 앞으로 오지 않았다' })
      .toMatch(/Electron|KNUAF Thesis Helper/)
    const file = `${OUT}/checkup-${scheme}.png`
    execFileSync('screencapture', ['-x', '-R', `${b.x},${b.y},${b.width},${b.height}`, file])
    console.log('captured', file, statSync(file).size, 'bytes')
    await electronApp.close()
  })
}
