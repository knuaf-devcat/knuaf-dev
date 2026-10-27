import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'
import { DEFAULT_WINDOW } from '../src/shared/window'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'

// 화면 캡처가 쓰는 자리. CI(맥·윈도우)에서는 `KNUAF_SHOT_DIR` 를 주어 아티팩트로 올릴 곳에
// 쓰고, 로컬 기본값은 지금처럼 `docs/images`(학생 안내서 사진 갱신)다 — 로컬 동작 불변.
const OUT = process.env.KNUAF_SHOT_DIR ?? resolve(__dirname, '..', '..', 'docs', 'images')
// [파일 이름, 목적지, 그 목적지가 열어야 하는 시트(`data-screen` 값; null 이면 시트를 닫은 장면)]
//
// 캡처는 **시트가 실제로 보인 뒤에만** 찍는다. 고정 대기만 두면 느린 기계에서 시트가 그려지기
// 전에 찍혀 "종이만 있고 시트가 없는" 캡처가 남는다(QA3-WIN-R01: 윈도우 CI 의
// 04-artifacts·08-settings 가 그랬다). 앱이 시트를 못 여는 것이면 이 단언이 시험을 실패시켜
// 캡처 시점 문제와 구분된다 — 조용히 잘못된 그림을 남기지 않는다.
//
// 그런데 그 단언이 통과해도 사진에는 시트가 없을 수 있었다(QA3-WIN-R02): 여는 움직임의 초기
// 프레임이 **투명**이고 Playwright 의 "보임"은 투명도를 보지 않는다. 그래서 지금은 ① 캡처 동안만
// 움직임을 꺼 최종 상태로 찍고(FREEZE), ② 찍기 전에 시트의 계산된 투명도·막·크기를 확인한다
// (`assertSheetPainted`) — 아래 두 상수의 주석에 실측 근거를 적어 두었다.
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

/**
 * 캡처 동안만 움직임을 끄고 **최종 상태**로 찍는다(QA3-WIN-R02).
 *
 * `dialog[open].sheet` 의 여는 움직임(`materialize`)은 `opacity: 0` 에서 시작하고 막
 * (`::backdrop`)도 `backdrop-in` 으로 0 에서 시작한다(`styles/motion.css:17-18`). 실측하면 시트를
 * 연 직후 계산된 투명도가 **0.03 · 막 0.07** 이다. 숨김 실행 창은 화면 프레임이 뜸하게 만들어져,
 * 캡처가 그 초기 프레임에 걸리면 **시트도 막도 안 보이는** 사진이 남는다 — 윈도우 CI 의
 * `08-settings.png` 가 시트를 닫은 장면(`02b-chat.png`)과 **바이트까지 같은**(27,980 바이트) 파일로
 * 남은 것이 그 증거다. Playwright 의 `toBeVisible` 은 투명도를 보지 않으므로 단언은 통과했다.
 *
 * 사진이 담는 것은 정지한 화면이므로, 캡처 동안 움직임을 끄고 끝 상태(투명도 1)로 찍는다.
 * 제품 CSS 는 건드리지 않는다 — 이 시험의 문서용 사진에만 적용된다.
 */
const FREEZE = `*, *::before, *::after { animation: none !important; transition: none !important; }
dialog[open].sheet { opacity: 1 !important; transform: none !important; filter: none !important; }
dialog[open].sheet::backdrop { opacity: 1 !important; }`

/**
 * 이 장면의 시트가 **사진에 실제로 그려질 상태**인지 확인한다.
 *
 * `toBeVisible` 만으로는 부족하다(위 FREEZE 주석: 투명도 0 도 "보임"이다) — 계산된 투명도
 * (시트와 막)와 상자 크기를 함께 본다. 앱이 시트를 못 여는 경우는 `toBeVisible` 이 잡고,
 * "열렸는데 사진에는 없다"(투명하거나 0 크기)는 이 검사가 잡는다 — 조용히 잘못된 그림을 남기지 않는다.
 */
async function assertSheetPainted(page: Page, screen: string): Promise<void> {
  const el = page.locator(`[data-screen="${screen}"]`)
  await expect(el, `${screen} 시트가 열리지 않았다`).toBeVisible({ timeout: 30_000 })
  const state = (): Promise<{ paint: string; w: number; h: number }> => el.evaluate((n) => {
    const box = n.getBoundingClientRect()
    // 막은 dialog 에만 있다(SheetOver 는 논문 칸을 덮는 div 다).
    const back = n.tagName === 'DIALOG' ? getComputedStyle(n, '::backdrop').opacity : '1'
    return { paint: `${getComputedStyle(n).opacity}|${back}`, w: Math.round(box.width), h: Math.round(box.height) }
  })
  await expect.poll(async () => (await state()).paint, {
    message: `${screen} 시트가 사진에 그려지지 않는다 — 투명하거나 막이 없다`,
    timeout: 15_000
  }).toBe('1|1')
  const { w, h } = await state()
  expect(w, `${screen} 시트가 가로로 비어 있다`).toBeGreaterThan(200)
  expect(h, `${screen} 시트가 세로로 비어 있다`).toBeGreaterThan(200)
  await page.waitForTimeout(600) // 그려진 뒤 색·레이아웃이 안정될 때까지(내용이 늦게 차는 화면)
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
    const { electronApp, page } = await launch({ colorScheme: scheme, env: fakeCodexEnv(join(scratch(), 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
    await page.setViewportSize(DEFAULT_WINDOW)
    // documentation shots use the solid sidebar (vibrancy is not captured by the web layer)
    await page.evaluate(() => { document.documentElement.dataset.vibrancy = 'off' })
    // 사진은 **정지한 화면**을 담는다 — 움직임은 캡처 동안만 끄고 최종 상태로 찍는다(아래 FREEZE).
    await page.addStyleTag({ content: FREEZE })
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
        await assertSheetPainted(page, screen)
      } else {
        // 시트를 닫은 장면이어야 한다 — 열린 채로 찍으면 다른 화면을 캡처한다.
        // 시트는 두 구현이 있다: `<Sheet>`(dialog.sheet)와 `<SheetOver>`(div.sheetover).
        // dialog[open] 만 보면 SheetOver 가 열린 채로 찍혀도 통과한다(CONFIRM-ASTRA-QA3-WIN 42행).
        await expect(page.locator('dialog[open], .sheetover'), '시트가 닫히지 않았다').toHaveCount(0, { timeout: 30_000 })
        await page.waitForTimeout(600) // 그려진 뒤 색·레이아웃이 안정될 때까지
      }
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
