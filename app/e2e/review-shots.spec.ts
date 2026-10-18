/**
 * 발주 QA2-B 캡처 생성기 — `impl/shots-qa2/review-*`(밝게·어둡게).
 *
 * `KNUAF_QA2_SHOTS=1` 일 때만 돈다 — 기본 e2e 실행(CI)에서 저장소 밖 폴더에 쓰지 않게 하려는
 * 것이다(qa-shots.spec.ts 와 같은 방식). 실행:
 *   KNUAF_QA2_SHOTS=1 pnpm -C app exec playwright test e2e/review-shots.spec.ts
 *
 * 찍는 자리(발주 §④): 고른 문장 행동 막대 · 입력칸 위 인용 칩 · 고친 부분 보기(지움/새것).
 */
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, openProject, rewriteSection, synthProject } from './helpers'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'

const OUT = process.env.KNUAF_QA2_SHOTS_DIR ?? resolve('/Users/nara/knuaf-dev/docs/design/gui-2026-10-opus-v5/impl/shots-qa2')
const noShots = process.env.KNUAF_QA2_SHOTS !== '1' || !existsSync(resolve(OUT, '..'))

async function settled(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(
    document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))
  ))
}

async function selectParagraph(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    const p = [...document.querySelectorAll('.sheet p')].find((el) => (el.textContent ?? '').includes(text))
    if (!p) throw new Error(`문단을 찾지 못했다: ${text}`)
    const range = document.createRange()
    range.selectNodeContents(p)
    const sel = window.getSelection()
    if (!sel) throw new Error('선택을 만들 수 없다')
    sel.removeAllRanges(); sel.addRange(range)
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, needle)
}

for (const scheme of ['light', 'dark'] as const) {
  test(`검토 캡처 (${scheme})`, async () => {
    test.skip(noShots, 'KNUAF_QA2_SHOTS=1 이고 대상 폴더가 있을 때만')
    test.setTimeout(180_000)
    mkdirSync(OUT, { recursive: true })
    const dir = scratch()
    const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
    const root = synthProject()
    const shot = async (page: Page, name: string): Promise<void> => {
      await settled(page)
      const file = join(OUT, `review-${name}-${scheme}.png`)
      await page.screenshot({ path: file })
      console.log('captured', file, statSync(file).size, 'bytes')
    }

    const { electronApp, page } = await launch({ colorScheme: scheme, env })
    try {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.evaluate(() => { document.documentElement.dataset.vibrancy = 'off' })
      await openProject(page, root)
      await expect(page.locator('.paperpane .sheet')).toContainText('600평', { timeout: 30_000 })
      // 인용 칩은 입력칸 위에 얹힌다 — 연결이 확인돼 입력칸이 설 때까지 기다린다.
      await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 30_000 })

      // ① 고른 문장 위 행동 막대
      await selectParagraph(page, '600평')
      await expect(page.locator('.selbar')).toBeVisible()
      await shot(page, 'selection')

      // ② 입력칸 위 인용 칩
      await page.locator('.selbar').getByRole('button', { name: '고쳐 달라기' }).click()
      await expect(page.locator('.review-chip')).toBeVisible()
      await shot(page, 'quote')

      // ③ 고친 부분 보기 — 도우미가 800평으로 다시 저장한 뒤
      rewriteSection(root, { body: '농장A의 재배 면적은 800평이다. 정읍 일대 기후를 고려해 작목을 선택했다.', expected: 1 })
      await expect(page.locator('.paperpane .sheet')).toContainText('800평', { timeout: 30_000 })
      await page.locator('.review-toggle').click()
      await expect(page.locator('.paperpane .sheet ins.rev-ins')).toBeVisible()
      await shot(page, 'diff')
    } finally {
      await electronApp.close()
    }
  })
}
