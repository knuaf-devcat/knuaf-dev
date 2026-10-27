import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import { fakeCodexEnv, replyFile, scratch, writeCliShim, writeStatefulClaude } from './fixtures/fake-codex'

const settings = (dir: string) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'))
const row = (page: Page, provider: 'codex' | 'claude') => page.locator(`[data-provider="${provider}"] .reason`).first()

for (const mode of ['new', 'legacy'] as const) {
  test(`${mode} 설정은 첫 화면에서 명시적 AI 선택을 지어내지 않는다`, async () => {
    const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
    if (mode === 'legacy') writeFileSync(join(userData, 'settings.json'), JSON.stringify({ helper_mode: 'claude-chat' }))
    const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
    const { electronApp, page } = await launch({ userData, onboarded: false, env: { HOME: home, PATH: '', KNUAF_AGENT_PATH_ONLY: '1' } })
    try {
      await expect(page.getByText('어떤 논문을 쓰고 있어요?')).toBeVisible()
      const s = await page.evaluate(() => window.knuaf.getSettings())
      expect(s.provider_choice).toBeNull()
      expect(s.helper_mode).toBe(mode === 'legacy' ? 'claude-chat' : 'codex-chat')
      expect(s.onboarded_at).toBeNull()
    } finally { await electronApp.close() }
  })
}

test('도구가 없을 때 모델 칩은 설치와 재확인을 제공한다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
  const { electronApp, page } = await launch({ onboarded: false, env: { HOME: home, PATH: '', KNUAF_AGENT_PATH_ONLY: '1' } })
  try {
    await page.getByTitle('이 논문의 도우미').click()
    await expect(row(page, 'codex')).toContainText('연결 도구(Codex)를 먼저 설치해요')
    await expect(row(page, 'claude')).toContainText('연결 도구(Claude Code)를 먼저 설치해요')
    await expect(page.getByRole('button', { name: '설치 안내' }).first()).toBeVisible()
    await page.getByRole('button', { name: '다시 확인' }).first().click()
    await expect(row(page, 'codex')).toContainText('연결 도구(Codex)를 먼저 설치해요')
  } finally { await electronApp.close() }
})

test('가짜 로그인 뒤 선택을 기록하고 첫 논문에서 자동으로 시작한다', async () => {
  const dir = scratch()
  const root = synthProject({ withContent: false })
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-out', FAKE_CODEX_STATE: join(dir, 'state'), FAKE_CODEX_REPLY: replyFile(dir, '첫 질문') })
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const { electronApp, page } = await launch({ userData, onboarded: false, env })
  try {
    await electronApp.evaluate(({ shell }) => { shell.openExternal = async () => {} })
    await page.getByTitle('이 논문의 도우미').click()
    await expect(row(page, 'codex')).toContainText('로그인이 필요해요')
    await page.getByRole('button', { name: 'ChatGPT로 로그인' }).click()
    await page.keyboard.press('Escape')
    await expect.poll(() => settings(userData).provider_choice?.provider, { timeout: 30000 }).toBe('codex')
    await openProject(page, root)
    await expect(page.locator('.chat-msg.user')).toHaveCount(1, { timeout: 30000 })
    await expect(page.locator('.chat-msg.user').first()).toContainText('시작하기')
    await expect(page.getByText('첫 질문')).toBeVisible({ timeout: 30000 })
    expect(settings(userData).onboarded_at).toBeTruthy()
    await expect(page.locator('.chat-msg.user')).toHaveCount(1)
  } finally { await electronApp.close() }
})

for (const first of ['codex', 'claude'] as const) {
  test(`${first} 로그인 중 다른 회사도 연결할 수 있다`, async () => {
    const dir = scratch()
    const bin = join(dir, 'bin')
    const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-out', FAKE_CODEX_STATE: join(dir, 'codex'), FAKE_CODEX_DELAY_MS: '4000' })
    writeStatefulClaude(bin, join(dir, 'claude'))
    const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
    const { electronApp, page } = await launch({ userData, onboarded: false, env })
    try {
      await electronApp.evaluate(({ shell }) => { shell.openExternal = async () => {} })
      await page.getByTitle('이 논문의 도우미').click()
      await expect(row(page, first)).toContainText('로그인이 필요해요', { timeout: 30000 })
      await page.getByRole('button', { name: first === 'codex' ? 'ChatGPT로 로그인' : 'Claude로 로그인' }).click()
      await page.getByRole('button', { name: first === 'codex' ? 'Claude로 로그인' : 'ChatGPT로 로그인' }).click()
      await expect(row(page, 'claude')).toContainText('연결됐어요', { timeout: 30000 })
      await expect(row(page, 'codex')).toContainText('연결됐어요', { timeout: 30000 })
      await expect.poll(() => settings(userData).provider_choice?.provider, { timeout: 30000 }).toBe('claude')
    } finally { await electronApp.close() }
  })
}

test('이미 연결된 선택은 다른 회사 로그인 뒤에도 유지된다', async () => {
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in' })
  writeStatefulClaude(bin, join(dir, 'claude'))
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ provider_choice: { provider: 'codex', at: new Date().toISOString() } }))
  const { electronApp, page } = await launch({ userData, onboarded: false, env })
  try {
    await electronApp.evaluate(({ shell }) => { shell.openExternal = async () => {} })
    await page.getByTitle('이 논문의 도우미').click()
    await expect(row(page, 'codex')).toContainText('연결됐어요', { timeout: 30000 })
    await page.getByRole('button', { name: 'Claude로 로그인' }).click()
    await expect(row(page, 'claude')).toContainText('연결됐어요', { timeout: 30000 })
    expect(settings(userData).provider_choice.provider).toBe('codex')
  } finally { await electronApp.close() }
})

test('연결 확인 실패를 로그인 필요로 말하지 않는다', async () => {
  const dir = scratch()
  const bin = join(dir, 'bin')
  writeCliShim(bin, 'claude', 'echo invalid-json', 'echo invalid-json')
  const env = { PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), KNUAF_AGENT_PATH_ONLY: '1', HOME: dir }
  const { electronApp, page } = await launch({ env })
  try {
    await page.getByTitle('이 논문의 도우미').click()
    await expect(row(page, 'claude')).toContainText('연결 상태를 확인하지 못했어요', { timeout: 30000 })
    await expect(page.getByRole('button', { name: 'Claude로 로그인' })).toHaveCount(0)
  } finally { await electronApp.close() }
})
