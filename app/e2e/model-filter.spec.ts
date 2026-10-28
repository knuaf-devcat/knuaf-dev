import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import { fakeCodexEnv, replyFile, scratch, seedChat, userDataWith } from './fixtures/fake-codex'
import { MODEL_PICKER } from '../src/renderer/src/copy'
import type { ModelChoice } from '../src/shared/chat'

const rejected = { model: 'commandcode-auth/gpt-5.6-terra', effort: 'high' }
const allowed = { model: 'GPT-6.1-Sol', effort: 'high' }
const models = ['GPT-6-Astra', 'GPT-6-Luna', allowed.model, rejected.model, 'anthropic/claude-sonnet-4'].map(model => ({
  id: model, model, displayName: model, defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }]
}))
const records = (file: string) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const captures = join(homedir(), 'work/knuaf-dev/2026-10-27-chat-redesign/mf-captures')

type ChatApi = {
  send(root: string, provider: string, text: string, id: string): Promise<{ error?: { message: string } }>
  setModel(root: string, provider: string, choice: ModelChoice | null): Promise<{ error?: { message: string } }>
  models(root: string, provider: string): Promise<{ result: { selected: ModelChoice | null; error?: string } }>
}
type ApiRequest = { root: string } & (
  { action: 'send'; id: string } | { action: 'setModel'; choice: ModelChoice | null } | { action: 'models' }
)
async function api(page: Page, request: ApiRequest) {
  return page.evaluate(async request => {
    // Electron's preload owns this API; the test mirrors its public IPC methods.
    const host = window as unknown as { knuaf: { chat: ChatApi } }
    const chat = host.knuaf.chat
    if (request.action === 'models') return { ...await chat.models(request.root, 'codex'), error: undefined }
    const reply = request.action === 'setModel'
      ? await chat.setModel(request.root, 'codex', request.choice)
      : await chat.send(request.root, 'codex', '이어서 써 주세요', request.id)
    return { ...reply, result: undefined }
  }, request)
}

async function scene(resumed: boolean, defaultModel: string, stored: ModelChoice | null = rejected, failList = false) {
  const dir = scratch(), root = synthProject({ withContent: false })
  const turns = join(dir, 'turns.jsonl'), thread = join(dir, 'thread.json')
  writeFileSync(turns, '')
  if (resumed) {
    seedChat(root, [{ id: 'old', role: 'assistant', text: '이전 답변', at: new Date().toISOString() }])
    const file = join(root, '.knuaf-gui', 'chat-codex.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), sessionId: 't-mf1' }))
    writeFileSync(thread, JSON.stringify({ threadId: 't-mf1', ...rejected }))
  }
  const userData = userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' }, chat_models: { codex: stored } })
  const app = await launch({ userData, env: fakeCodexEnv(join(dir, 'bin'), {
    FAKE_CODEX_MODELS: JSON.stringify(models), FAKE_CODEX_DEFAULT_MODEL: defaultModel,
    FAKE_CODEX_MODELS_FAIL_TIMES: failList ? '1' : '0', FAKE_CODEX_THREAD_STATE: thread,
    FAKE_CODEX_TURN_LOG: turns, FAKE_CODEX_REPLY: replyFile(dir, 'MF1 응답')
  }) })
  await openProject(app.page, root)
  await expect(app.page.getByTitle('이 논문의 도우미')).toContainText(
    stored?.model.includes('/') ? MODEL_PICKER.reselectionTitle : stored?.model ?? '연결됨'
  )
  return { ...app, root, turns, userData }
}

async function send(page: Page, root: string, id: string) {
  let result: { error?: { message: string } } = {}
  await expect.poll(async () => {
    result = await api(page, { action: 'send', root, id })
    return result.error?.message.includes('저장·검사 작업 중') ?? false
  }).toBe(false)
  return result
}

for (const scenario of [
  { name: 'fresh', resumed: false, defaultModel: 'GPT-6-Astra' },
  { name: 'resumed-openai', resumed: true, defaultModel: 'GPT-6-Astra' },
  { name: 'resumed-cross', resumed: true, defaultModel: 'anthropic/claude-sonnet-4' }
]) {
  test(`MF1-01: ${scenario.name} 저장 외부 선택은 재선택 전 차단하고 허용 모델 선택 뒤에만 전송한다`, async () => {
    const { electronApp, page, root, turns, userData } = await scene(scenario.resumed, scenario.defaultModel)
    try {
      const blocked = await send(page, root, 'blocked')
      expect(blocked.error?.message).toBe(MODEL_PICKER.reselectionRequired)
      expect(records(turns)).toEqual([])
      expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).chat_models.codex).toEqual(rejected)
      const draft = page.getByRole('textbox', { name: '답변을 입력하세요' })
      await draft.fill('보존할 초안')
      await page.getByRole('button', { name: '보내기', exact: true }).click()
      await expect(page.getByText(MODEL_PICKER.reselectionRequired, { exact: true })).toBeVisible()
      await expect(draft).toHaveValue('보존할 초안')
      await page.getByTitle('이 논문의 도우미').click()
      const popup = page.locator('.composer-model-host .popover')
      await expect(popup.getByRole('button', { name: /안 고름/ })).toHaveAttribute('aria-pressed', 'false')
      if (scenario.name === 'fresh') {
        mkdirSync(captures, { recursive: true })
        await page.screenshot({ path: join(captures, 'mf1-reselection.png') })
      }
      await popup.getByRole('button', { name: /^GPT-6.1-Sol / }).click()
      await page.keyboard.press('Escape')
      await expect(page.getByTitle('이 논문의 도우미')).toContainText(allowed.model)
      expect((await send(page, root, 'allowed')).error).toBeUndefined()
      await expect.poll(() => records(turns)).toEqual([{ model: allowed.model, effort: 'medium' }])
    } finally { await electronApp.close() }
  })
}

test('MF1-02: 목록 실패에도 외부 선택은 재선택 표시·전송 차단을 유지하며 명시적 기본 선택 뒤 복구한다', async () => {
  const { electronApp, page, root, turns } = await scene(true, 'GPT-6-Astra', rejected, true)
  try {
    await page.getByTitle('이 논문의 도우미').click()
    const popup = page.locator('.composer-model-host .popover')
    await expect(popup.getByText(MODEL_PICKER.listFailed, { exact: true })).toBeVisible()
    await expect(page.getByTitle('이 논문의 도우미')).toContainText(MODEL_PICKER.reselectionTitle)
    await expect(page.getByTitle('이 논문의 도우미')).not.toContainText(rejected.model)
    expect((await send(page, root, 'failed-list')).error?.message).toBe(MODEL_PICKER.reselectionRequired)
    expect(records(turns)).toEqual([])
    mkdirSync(captures, { recursive: true })
    await page.screenshot({ path: join(captures, 'mf1-list-failed.png') })
    await popup.getByRole('button', { name: /안 고름/ }).click()
    await expect(popup.getByRole('button', { name: /안 고름/ })).toHaveAttribute('aria-pressed', 'true')
    expect((await send(page, root, 'explicit-default')).error).toBeUndefined()
    await expect.poll(() => records(turns)).toEqual([{ model: 'GPT-6-Astra', effort: 'medium' }])
  } finally { await electronApp.close() }
})

test('명시적 계정 기본 선택 뒤에도 외부 공급자 기본값은 차단하고 허용 모델로 복구한다', async () => {
  const { electronApp, page, root, turns } = await scene(true, 'anthropic/claude-sonnet-4')
  try {
    expect((await api(page, { action: 'setModel', root, choice: null })).error).toBeUndefined()
    expect((await send(page, root, 'cross-default')).error?.message).toBe(MODEL_PICKER.crossProviderDefault)
    expect(records(turns)).toEqual([])
    await api(page, { action: 'setModel', root, choice: allowed })
    expect((await send(page, root, 'safe-model')).error).toBeUndefined()
    await expect.poll(() => records(turns)).toEqual([allowed])
  } finally { await electronApp.close() }
})

test('정상 OpenAI 저장 선택은 목록 실패로 지우지 않고 그대로 전송한다', async () => {
  const { electronApp, page, root, turns } = await scene(false, 'GPT-6-Astra', allowed, true)
  try {
    const result = await api(page, { action: 'models', root })
    expect(result.result?.error).toBeTruthy()
    expect(result.result?.selected).toEqual(allowed)
    expect((await send(page, root, 'normal-choice')).error).toBeUndefined()
    await expect.poll(() => records(turns)).toEqual([allowed])
  } finally { await electronApp.close() }
})
