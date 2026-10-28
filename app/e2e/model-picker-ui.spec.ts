import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import { fakeCodexEnv, replyFile, scratch, seedChat, userDataWith, writeFakeClaude } from './fixtures/fake-codex'

const option = (model: string, name: string, hidden = false) => ({
  id: model, model, displayName: name, hidden, description: `${name} 모델 설명`,
  defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }]
})
const lowModels = [option('gpt-terra', 'Terra'), option('gpt-luna', 'Luna'), option('gpt-hidden-sol', 'Sol', true)]
const highModels = [option('gpt-sol', 'Sol'), option('gpt-astra', 'Astra'), option('gpt-terra', 'Terra'), option('gpt-luna', 'Luna')]

async function scene(models = highModels, colorScheme: 'light' | 'dark' = 'light', extra: Record<string, string> = {}, settings: Record<string, unknown> = {}) {
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODELS: JSON.stringify(models), FAKE_CODEX_REPLY: replyFile(dir, '작업을 마쳤어요.'), ...extra })
  writeFakeClaude(bin)
  const userData = userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' }, ...settings })
  const app = await launch({ env, userData, colorScheme })
  return { ...app, dir, userData }
}

for (const tier of ['low', 'high'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${tier} 계정 · ${theme}: 추천은 이용 가능한 모델만 보이고 1440·1024 창 안에 맞는다`, async ({}, info) => {
      const { electronApp, page } = await scene(tier === 'low' ? lowModels : highModels, theme)
      const root = synthProject()
      seedChat(root, [{ id: 'a0', role: 'assistant', text: 'Ⅰ. 머리말을 저장했어요.', at: new Date().toISOString() }])
      try {
        await openProject(page, root)
        const chip = page.getByTitle('이 논문의 도우미')
        await expect(chip).toContainText('연결됨')
        for (const width of [1440, 1024]) {
          await electronApp.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setBounds({ width: w, height: 900 }), width)
          await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
          await chip.click()
          const popup = page.locator('.composer-model-host .popover')
          const rows = popup.locator('.model-option')
          await expect(rows).toHaveCount(tier === 'low' ? 3 : 5)
          await expect(popup.getByRole('button', { name: /안 고름/ })).toHaveAttribute('aria-pressed', 'true')
          if (tier === 'low') {
            await expect(rows.filter({ hasText: 'Terra' })).toContainText('설계 · 검토(새 대화)에 추천')
            await expect(rows.filter({ hasText: 'Luna' })).toContainText('자료 찾기 · 글쓰기 · 반복 작업에 추천')
            await expect(rows.filter({ hasText: 'Sol' })).toHaveCount(0)
          } else {
            await expect(rows.filter({ hasText: 'Sol' })).toContainText('설계에 추천')
            await expect(rows.filter({ hasText: 'Astra' })).toContainText('자료 찾기 · 검토(새 대화)에 추천')
            await expect(rows.filter({ hasText: 'Terra' })).toContainText('글쓰기에 추천')
            await expect(rows.filter({ hasText: 'Luna' })).toContainText('반복 작업에 추천')
          }
          await expect(popup).toContainText('검토는 새 대화로 하세요.')
          const bounds = await popup.boundingBox()
          expect(bounds).not.toBeNull()
          expect(bounds!.x).toBeGreaterThanOrEqual(0)
          expect(bounds!.y).toBeGreaterThanOrEqual(0)
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900)
          // 마지막 안내도 스크롤로 도달할 수 있어야 한다.
          const footer = popup.getByText('앱은 AI를 팔지 않아요. 내 구독 계정을 써요.')
          await footer.scrollIntoViewIfNeeded()
          await expect(footer).toBeVisible()
          await popup.locator('.pop-scroll').evaluate((el) => { el.scrollTop = 0 })
          const captureDir = process.env.KNUAF_CHIP_CAPTURE_DIR
          if (captureDir) mkdirSync(captureDir, { recursive: true })
          await page.screenshot({ path: captureDir ? join(captureDir, `chip-${tier}-${theme}-${width}.png`) : info.outputPath(`chip-${width}.png`) })
          await page.keyboard.press('Escape')
          await expect(popup).toHaveCount(0)
          await expect(chip).toBeFocused()
        }
      } finally { await electronApp.close() }
    })
  }
}

test('폴더 없이 모델·깊이를 고르고 다음 메시지부터 같은 대화에서 바꾸거나 해제한다', async () => {
  const dir = scratch()
  const log = join(dir, 'turns.jsonl')
  const { electronApp, page } = await scene(highModels, 'light', { FAKE_CODEX_TURN_LOG: log })
  const root = synthProject({ withContent: false })
  try {
    const chip = page.getByTitle('이 논문의 도우미')
    await expect(chip).toContainText('연결됨')
    await chip.click()
    const popup = page.locator('.composer-model-host .popover')
    await popup.getByRole('button', { name: /^Sol / }).click()
    await expect(popup.getByRole('button', { name: /^Sol / })).toHaveAttribute('aria-pressed', 'true')
    await popup.getByLabel('생각 깊이').selectOption('high')
    await expect(chip).toContainText('Sol · 생각 깊이 높게')
    await expect(popup.getByLabel('생각 깊이')).toBeEnabled()
    await page.keyboard.press('Escape')
    // 폴더 선택으로 모델 설정이 바뀌지 않는다. 이후 실제 IPC 전송값을 확인한다.
    await openProject(page, root)
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('전체 설계를 해 주세요')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('작업을 마쳤어요.', { exact: true })).toBeVisible()
    const first = JSON.parse(readFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), 'utf8')) as { sessionId: string }
    await chip.click()
    await popup.getByRole('button', { name: /^Terra / }).click()
    await expect(chip).toContainText('Terra · 생각 깊이 기본')
    await page.keyboard.press('Escape')
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('이어서 써 주세요')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect.poll(() => readFileSync(log, 'utf8').trim().split('\n').length).toBe(2)
    await expect(page.getByRole('button', { name: '중단', exact: true })).toHaveCount(0)
    await chip.click()
    await popup.getByRole('button', { name: /안 고름/ }).click()
    await expect(popup.getByRole('button', { name: /안 고름/ })).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('계정 기본으로 이어 주세요')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect.poll(() => readFileSync(log, 'utf8').trim().split('\n').length).toBe(3)
    expect(readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([
      { model: 'gpt-sol', effort: 'high' }, { model: 'gpt-terra', effort: 'medium' }, { model: 'gpt-default', effort: 'medium' }
    ])
    const last = JSON.parse(readFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), 'utf8')) as { sessionId: string }
    expect(last.sessionId).toBe(first.sessionId)
  } finally { await electronApp.close() }
})

test('다른 공급자 모델은 칩 목록에도 추천에도 나오지 않는다 (DQA-01)', async () => {
  const mixed = [
    ...highModels,
    option('anthropic/claude-sonnet-4', 'Claude Sonnet 4'),
    // 실측: 이 id 에 '글쓰기' 추천이 붙었던 장면. OpenAI Terra 가 아니라 이 모델이 잡혔다.
    option('commandcode-auth/gpt-5.6-terra', 'Terra')
  ]
  const { electronApp, page } = await scene(mixed)
  try {
    const chip = page.getByTitle('이 논문의 도우미')
    await expect(chip).toContainText('연결됨')
    await chip.click()
    const popup = page.locator('.composer-model-host .popover')
    const rows = popup.locator('.model-option')
    // OpenAI 네 개 + '안 고름'. 접두어 모델 두 개는 목록에 없다.
    await expect(rows).toHaveCount(5)
    await expect(rows.filter({ hasText: 'Claude Sonnet 4' })).toHaveCount(0)
    // Terra 는 OpenAI 것 하나뿐이고, 글쓰기 추천은 그 하나에만 붙는다.
    await expect(rows.filter({ hasText: 'Terra' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Terra' })).toContainText('글쓰기에 추천')
  } finally { await electronApp.close() }
})

test('실측 순서의 같은 별칭 여러 세대 중 최신 모델에만 추천한다', async () => {
  const names = ['GPT-6-Astra', 'GPT-6-Luna', 'GPT-6.1-Sol', 'GPT-5.5', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-6-Sol', 'GPT-6.1 Terra']
  const { electronApp, page } = await scene(names.map((name) => option(name, name)))
  try {
    const chip = page.getByTitle('이 논문의 도우미')
    await expect(chip).toContainText('연결됨')
    await chip.click()
    const rows = page.locator('.composer-model-host .popover .model-option')
    await expect(rows).toHaveCount(10)
    for (const [name, purpose] of [
      ['GPT-6-Astra', '자료 찾기 · 검토(새 대화)에 추천'],
      ['GPT-6-Luna', '반복 작업에 추천'],
      ['GPT-6.1-Sol', '설계에 추천'],
      ['GPT-6.1 Terra', '글쓰기에 추천']
    ]) {
      const row = rows.filter({ has: page.getByText(name, { exact: true }) })
      await expect(row).toContainText(purpose)
      await expect(row.locator('.model-recommend')).toHaveCount(1)
    }
    for (const name of ['GPT-5.5', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-6-Sol']) {
      await expect(rows.filter({ has: page.getByText(name, { exact: true }) }).locator('.model-recommend')).toHaveCount(0)
    }
  } finally { await electronApp.close() }
})


test('빈 목록도 기본값으로 둘 수 있고 Claude는 모델 추천 없이 기본값을 유지한다', async () => {
  const { electronApp, page } = await scene([])
  try {
    const chip = page.getByTitle('이 논문의 도우미')
    await expect(chip).toContainText('연결됨')
    await chip.click()
    const popup = page.locator('.composer-model-host .popover')
    await expect(popup).toContainText('이 계정에서 고를 수 있는 모델이 없어요.')
    await expect(popup.getByLabel('생각 깊이')).toBeDisabled()
    await popup.getByRole('button', { name: 'Claude로 바꾸기' }).click()
    await expect(chip).toContainText('Claude')
    await chip.click()
    await expect(popup.locator('.model-option')).toHaveCount(0)
    await expect(popup.locator('.model-recommend')).toHaveCount(0)
    await expect(popup).toContainText('내 Claude 설정을 따라요')
  } finally { await electronApp.close() }
})

test('목록 오류는 재조회로 복구하고 실패 중에도 계정 기본 선택과 초안을 지킨다', async () => {
  const { electronApp, page } = await scene(highModels, 'light', { FAKE_CODEX_MODELS_FAIL_TIMES: '1' })
  try {
    const draft = page.getByRole('textbox', { name: '답변을 입력하세요' })
    await draft.fill('쓰던 문장은 남겨 주세요')
    const chip = page.getByTitle('이 논문의 도우미')
    await expect(chip).toContainText('연결됨')
    await chip.click()
    const popup = page.locator('.composer-model-host .popover')
    await expect(popup.getByRole('alert')).toContainText('모델 목록을 불러오지 못했어요.')
    await expect(popup.getByRole('button', { name: /안 고름/ })).toHaveAttribute('aria-pressed', 'true')
    await popup.getByRole('button', { name: '다시 확인', exact: true }).click()
    await expect(popup.locator('.model-option')).toHaveCount(5)
    await expect(popup.getByRole('alert')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(draft).toHaveValue('쓰던 문장은 남겨 주세요')
  } finally { await electronApp.close() }
})
