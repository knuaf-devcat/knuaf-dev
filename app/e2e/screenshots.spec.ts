import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'

// 화면 캡처가 쓰는 자리. CI(맥·윈도우)에서는 `KNUAF_SHOT_DIR` 를 주어 아티팩트로 올릴 곳에
// 쓰고, 로컬 기본값은 지금처럼 `docs/images`(학생 안내서 사진 갱신)다 — 로컬 동작 불변.
const OUT = process.env.KNUAF_SHOT_DIR ?? resolve(__dirname, '..', '..', 'docs', 'images')
// [파일 이름, 목적지, 그 목적지가 열어야 하는 시트(`data-screen` 값; null 이면 시트를 닫은 장면)]
//
// 캡처는 **시트가 실제로 보인 뒤에만** 찍는다. 고정 대기만 두면 느린 기계에서 시트가 그려지기
// 전에 찍혀 "종이만 있고 시트가 없는" 캡처가 남는다(QA3-WIN-R01: 윈도우 CI 의
// 04-artifacts·08-settings 가 그랬다). 앱이 시트를 못 여는 것이면 이 단언이 시험을 실패시켜
// 캡처 시점 문제와 구분된다 — 조용히 잘못된 그림을 남기지 않는다.
const SCREENS: [string, string, string | null][] = [
  ['02-checkup', '점검', 'checkup'],
  ['02b-chat', '내 논문', null], // 시트를 닫은 대화 장면
  ['07-materials', '자료', 'materials'],
  ['04-artifacts', '결과물', 'artifacts'],
  ['08-settings', '설정', 'settings'],
]

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
    mkdirSync(OUT, { recursive: true })   // CI 에서는 test-results 아래 새 폴더일 수 있다
    const root = synthProject()
    // Pre-stage the docx input so '논문 파일(워드) 만들기' skips paper.generate and goes straight to docx.build.
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
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    await navTo(page, '점검')
    await page.waitForSelector('[data-screen="checkup"]', { timeout: 30_000 })
    for (const [file, nav, screen] of SCREENS) {
      await navTo(page, nav)
      if (screen) {
        await expect(page.locator(`[data-screen="${screen}"]`), `${nav} 시트가 열리지 않았다`).toBeVisible({ timeout: 30_000 })
      } else {
        // 시트를 닫은 장면이어야 한다 — 열린 채로 찍으면 다른 화면을 캡처한다.
        await expect(page.locator('dialog[open]'), '시트가 닫히지 않았다').toHaveCount(0, { timeout: 30_000 })
      }
      await page.waitForTimeout(600) // 그려진 뒤 색·레이아웃이 안정될 때까지
      await page.screenshot({ path: `${OUT}/${file}${suffix}.png` })
    }

    // 파일 만들기 실행 후 — ResultCard(ok/blocked/fail 배경 구분)가 보이는 상태를 남긴다.
    await ensureDeps(page, root)
    await navTo(page, '결과물')
    await page.click('.make-row:has-text("논문 파일(워드) 만들기") button')
    await page.waitForSelector('.result', { timeout: 120_000 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${OUT}/04b-artifacts-made${suffix}.png` })
    await electronApp.close()
  })
}
