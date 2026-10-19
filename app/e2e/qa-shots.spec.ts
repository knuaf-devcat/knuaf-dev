/**
 * 시안 대조 QA 수정 묶음 — 캡처 생성기(발주: `impl/shots-qa/`에 밝게·어둡게).
 *
 * 창을 띄우지 않는 숨김 실행으로 찍는다(`launch()` 가 `KNUAF_E2E_HIDDEN=1`). 이 스펙은
 * `KNUAF_QA_SHOTS=1` 일 때만 돈다 — 기본 e2e 실행(CI)에서 저장소 밖 폴더에 쓰지 않게 하려는
 * 것이다. 실행: `KNUAF_QA_SHOTS=1 pnpm -C app exec playwright test e2e/qa-shots.spec.ts`.
 *
 * 찍는 자리(발주): 입력칸 · 점검 시트 · 결과물 · 설정 · 재실행 첫 화면 · 경고 상자.
 */
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'
import { fakeCodexEnv, scratch, writeFakeClaude } from './fixtures/fake-codex'

const OUT = process.env.KNUAF_QA_SHOTS_DIR ?? resolve('/Users/nara/knuaf-dev/docs/design/gui-2026-10-opus-v5/impl/shots-qa')
const noShots = process.env.KNUAF_QA_SHOTS !== '1' || !existsSync(resolve(OUT, '..'))
test.skip(noShots, 'KNUAF_QA_SHOTS=1 이고 대상 폴더가 있을 때만')

async function settled(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(
    document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))
  ))
}

for (const scheme of ['light', 'dark'] as const) {
  test(`QA 캡처 (${scheme})`, async () => {
    test.setTimeout(180_000)
    mkdirSync(OUT, { recursive: true })
    const dir = scratch()
    const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
    writeFakeClaude(join(dir, 'bin'))   // 저장된 선택(codex)+둘 다 연결 → 재실행 첫 화면이 폴더 단계(W2 D2)
    const root = synthProject()
    const shot = async (page: Page, name: string): Promise<void> => {
      await settled(page)
      const file = join(OUT, `${name}-${scheme}.png`)
      await page.screenshot({ path: file })
      console.log('captured', file, statSync(file).size, 'bytes')
    }

    // --- 입력칸 · 경고 상자(결과물 시트의 독립검토 고지) ---
    const { electronApp, page } = await launch({ colorScheme: scheme, env })
    try {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.evaluate(() => { document.documentElement.dataset.vibrancy = 'off' })
      await openProject(page, root)
      await page.waitForSelector('.chat-composer', { timeout: 30_000 })
      await shot(page, '01-composer')
      await navTo(page, '점검')
      await page.waitForSelector('[data-screen="checkup"]', { timeout: 30_000 })
      await shot(page, '02-checkup')
      await navTo(page, '결과물')
      await expect(page.locator('.feedback.warning').first()).toBeVisible({ timeout: 20_000 })
      await shot(page, '03-artifacts-warning')
      await navTo(page, '설정')
      await shot(page, '04-settings')
    } finally {
      await electronApp.close()
    }

    // --- 재실행 첫 화면(시안 ② 폴더 화면) ---
    const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({
      show_intro: false, onboarded_at: '2026-10-18T00:00:00.000Z',
      provider_choice: { provider: 'codex', at: '2026-10-18T00:00:00.000Z' },
      recent: [{ root, opened_at: '2026-10-18T00:00:00.000Z' }]
    }), 'utf-8')
    const second = await launch({ userData, colorScheme: scheme, env, waitFor: 'text=논문을 담을 폴더를 골라요' })
    try {
      await second.page.setViewportSize({ width: 1280, height: 800 })
      await second.page.evaluate(() => { document.documentElement.dataset.vibrancy = 'off' })
      await shot(second.page, '05-relaunch-first')
    } finally {
      await second.electronApp.close()
    }
  })
}
