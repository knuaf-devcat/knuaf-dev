/**
 * 아래 칸 화면 캡처 — 설계자가 v5 `shots/D·E·F·G` 와 나란히 놓고 보는 자료다.
 * 밝게·어둡게 × 네 장면(질문 카드 · 직접 입력 · 허락 · 작업 중).
 *
 * 저장 자리는 `KNUAF_SHOT_DIR`(없으면 git 이 무시하는 `app/test-results/p1-shots`).
 * `docs/images/*` 는 학생 안내서 사진이라 이 파일이 건드리지 않는다.
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, openProject, PROGRESS } from './helpers'
import { scratch, fakeCodexEnv, questionMessage, questionProject, seedChat, userDataWith } from './fixtures/fake-codex'

const OUT = process.env.KNUAF_SHOT_DIR ?? resolve(__dirname, '..', 'test-results', 'p1-shots')
const SCHEMES = ['light', 'dark'] as const

async function shoot(
  name: string,
  scheme: 'light' | 'dark',
  env: Record<string, string>,
  after: (page: Page) => Promise<void>,
  settings: Record<string, unknown> = {}
): Promise<void> {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [questionMessage()])
  const { electronApp, page } = await launch({ colorScheme: scheme, env: fakeCodexEnv(`${dir}/bin`, env), userData: userDataWith(dir, settings) })
  try {
    await page.setViewportSize({ width: 1180, height: 800 })
    // 문서용 캡처는 불투명 사이드바로 남긴다(웹 레이어가 vibrancy 를 담지 못한다).
    await page.evaluate(() => { document.documentElement.dataset.vibrancy = 'off' })
    await openProject(page, root)
    await expect(page.locator('.qcard')).toBeVisible({ timeout: 30_000 })
    await after(page)
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(OUT, `${name}${scheme === 'dark' ? '-dark' : ''}.png`) })
  } finally {
    await electronApp.close()
  }
}

test.beforeAll(() => { mkdirSync(OUT, { recursive: true }) })

test('질문 카드 캡처', async () => {
  test.setTimeout(180_000)
  for (const scheme of SCHEMES) {
    await shoot('question-card', scheme, { FAKE_CODEX_MODE: 'logged-in' }, async (page) => {
      await expect(page.locator('.qcard-opts .qopt').first()).toBeVisible()
    })
  }
})

test('직접 입력 캡처', async () => {
  test.setTimeout(180_000)
  for (const scheme of SCHEMES) {
    await shoot('direct-input', scheme, { FAKE_CODEX_MODE: 'logged-in' }, async (page) => {
      await page.locator('.qopt.free').click()
      await page.locator('.freebox textarea').fill('1000평 중에 300평은 체험용이라 그건 직접 따서 가져가요. 나머지는 온라인')
      await expect(page.locator('.freebox textarea')).toHaveValue(/체험용/)
    })
  }
})

test('허락 카드 캡처', async () => {
  test.setTimeout(180_000)
  for (const scheme of SCHEMES) {
    await shoot('permission', scheme, { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_ASK: '1' }, async (page) => {
      await page.getByRole('radio', { name: /농협 공판장/ }).click()
      await expect(page.locator('.askcard')).toBeVisible({ timeout: 30_000 })
    }, { permission_mode: 'ask' })
  }
})

test('작업 중 캡처', async () => {
  test.setTimeout(180_000)
  for (const scheme of SCHEMES) {
    await shoot('running', scheme, { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_HOLD: '1' }, async (page) => {
      await page.getByRole('radio', { name: /농협 공판장/ }).click()
      await expect(page.locator(PROGRESS)).toHaveCount(1, { timeout: 30_000 })
      await expect(page.locator(PROGRESS)).toBeVisible()
      await page.locator('.chat-composer textarea').fill('다음에 할 말을 미리 써 둘 수 있어요')
    })
  }
})
