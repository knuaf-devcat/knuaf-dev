import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject } from './helpers'
import { fakeCodexEnv, questionMessage, questionProject, scratch, seedChat } from './fixtures/fake-codex'

const out = process.env.KNUAF_SHOT_DIR ?? '/tmp/knuaf-pr3-shots'
const question = `[Q2] 기본 계획\n\n네 가지를 알려주세요.\n\n1. 전공 (학과 소속)\n   예: 특용작물전공 / 채소전공\n   미정이면: 학과를 알려주세요\n\n2. 작목 (재배할 주작목)\n   예: 도라지 / 새싹삼\n   미정이면: 후보를 비교해 드립니다\n\n3. 지역 (창업 예정 시·군)\n   예: 경남 김해\n   미정이면: 지역을 조사해 드립니다\n\n4. 자금 (자기자본과 융자를 나눠서)\n   가족 지원이 있으면 적어주세요\n   예: 자기자본 1억, 융자 3억\n   미정이면: 표준 모델을 제시합니다\n\n각 항목에 값을 적거나 미정이라고 답해주세요.`

test('밝게 어둡게 최소 창 질문창 캡처', async () => {
  test.setTimeout(180000)
  mkdirSync(out, { recursive: true })
  for (const [scheme, width, height, name] of [['light', 1180, 800, 'light'], ['dark', 1180, 800, 'dark'], ['light', 900, 600, 'minimum']] as const) {
    const dir = scratch(), root = questionProject()
    seedChat(root, [questionMessage('form', question)])
    const { electronApp, page } = await launch({ colorScheme: scheme, env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
    try {
      await page.setViewportSize({ width, height })
      await page.evaluate(() => { document.documentElement.dataset.vibrancy = 'off' })
      await openProject(page, root)
      await expect(page.locator('.qform')).toBeVisible({ timeout: 30000 })
      await page.screenshot({ path: join(out, `${name}.png`) })
    } finally { await electronApp.close() }
  }
})
