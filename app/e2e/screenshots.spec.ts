import { test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'

const OUT = resolve(__dirname, '..', '..', 'docs', 'images')
const SCREENS: [string, string][] = [['02-checkup', '점검'], ['02b-chat', '내 논문'], ['07-materials', '자료'], ['04-artifacts', '결과물'], ['08-settings', '설정']]

/**
 * docx.build needs the project .venv (methods_scripts._python_for). deps.ensure is skipped
 * when the running interpreter already satisfies the manifest (dev/e2e), so create the
 * project venv explicitly — same IPC as 설정 > 문제 해결 > 준비 상태.
 */
async function ensureDeps(page: Page, root: string): Promise<void> {
  const r = await page.evaluate((p) => window.knuaf.depsEnsure(p), root)
  const env = (r as { result?: { ok?: boolean } }).result
  if (!env?.ok) throw new Error(`deps.ensure failed: ${JSON.stringify(r).slice(0, 400)}`)
}

for (const scheme of ['light', 'dark'] as const) {
  test(`screenshots (${scheme})`, async () => {
    // deps.ensure (venv + pip install) can take minutes on a cold project.
    test.setTimeout(300_000)
    const root = synthProject()
    // Pre-stage the docx input so '논문 DOCX 만들기' skips paper.generate and goes straight to docx.build.
    mkdirSync(join(root, 'build'), { recursive: true })
    writeFileSync(join(root, 'build', '검토전_본문.md'), '# Ⅰ. 머리말\n\n농장A의 재배 면적은 600평이다.\n', 'utf-8')
    const { electronApp, page } = await launch({ colorScheme: scheme })
    await page.setViewportSize({ width: 1180, height: 800 })
    // documentation shots use the solid sidebar (vibrancy is not captured by the web layer)
    await page.evaluate(() => { document.documentElement.dataset.vibrancy = 'off' })
    const suffix = scheme === 'dark' ? '-dark' : ''
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${OUT}/01-home${suffix}.png` })
    await openProject(page, root)
    await page.waitForSelector('h1:has-text("내 논문")', { timeout: 30_000 })
    await navTo(page, '점검')
    await page.waitForSelector('h1:has-text("점검")', { timeout: 30_000 })
    for (const [file, nav] of SCREENS) {
      await navTo(page, nav)
      await page.waitForTimeout(600)
      await page.screenshot({ path: `${OUT}/${file}${suffix}.png` })
    }

    // 파일 만들기 실행 후 — ResultCard(ok/blocked/fail 배경 구분)가 보이는 상태를 남긴다.
    await ensureDeps(page, root)
    await navTo(page, '결과물')
    await page.click('button:has-text("논문 DOCX 만들기")')
    await page.waitForSelector('.result', { timeout: 120_000 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${OUT}/04b-artifacts-made${suffix}.png` })
    await electronApp.close()
  })
}
