import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import { fakeCodexEnv, replyFile, scratch, writeFakeClaude } from './fixtures/fake-codex'

test('첫 메시지에서 폴더를 열고 가짜 도우미에 전달한다', async () => {
  const dir = scratch()
  const root = synthProject({ withContent: false })
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, '첫 답변입니다') })
  const { electronApp, page } = await launch({ onboarded: false, env })
  try {
    await electronApp.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected], bookmarks: [] }) }, root)
    await expect(page.getByText('어떤 논문을 쓰고 있어요?')).toBeVisible()
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨', { timeout: 30000 })
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('딸기 농장 창업 논문을 쓰고 싶어요')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('딸기 농장 창업 논문을 쓰고 싶어요')).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('첫 답변입니다')).toBeVisible({ timeout: 30000 })
    expect((await page.evaluate(() => window.knuaf.getSettings())).provider_choice?.provider).toBe('codex')
    await expect(page.getByLabel('프로젝트').getByRole('button', { name: basename(root), exact: true })).toBeVisible()
  } finally { await electronApp.close() }
})


test('기존 논문을 고를 때 저장된 미전송 초안을 보존한다', async () => {
  const dir = scratch()
  const root = synthProject({ withContent: false })
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  writeFileSync(join(root, '.knuaf-gui', 'draft.txt'), '기존에 쓰던 초안')
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, '첫 답변입니다') })
  const { electronApp, page } = await launch({ onboarded: false, env })
  try {
    await electronApp.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected], bookmarks: [] }) }, root)
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('새 질문')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('첫 답변입니다')).toBeVisible({ timeout: 30000 })
    await expect(page.getByRole('textbox', { name: '답변을 입력하세요' })).toHaveValue('기존에 쓰던 초안')
  } finally { await electronApp.close() }
})

test('다른 회사로 바꾸기 전과 후에 맥락 손실을 알린다', async () => {
  const dir = scratch()
  const root = synthProject({ withContent: false })
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in' })
  writeFakeClaude(bin)
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const chip = page.getByTitle('이 논문의 도우미')
    await expect(chip).toBeVisible({ timeout: 30000 })
    await chip.click()
    await expect(page.getByText('AI 회사를 바꾸면 이전 대화 맥락이 이어지지 않을 수 있어요.')).toBeVisible()
    await page.getByRole('button', { name: 'Claude로 바꾸기' }).click()
    await expect(page.getByText(/Claude는 ChatGPT와 나눈 대화를 볼 수 없어요/)).toBeVisible()
  } finally { await electronApp.close() }
})

test('기본·1180·1024 창에서 목록을 먼저 접고 두 칸 경계를 지킨다', async () => {
  const dir = scratch()
  const root = synthProject()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const shots = join(process.cwd(), 'test-results', 'shell-shots')
  mkdirSync(shots, { recursive: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    const { electronApp, page } = await launch({ colorScheme, env })
    try {
      await page.screenshot({ path: join(shots, `start-${colorScheme}.png`) })
      await openProject(page, root)
      await expect(page.locator('.workspace')).not.toHaveClass(/entering/, { timeout: 30000 })
      for (const [width, label] of [[1440, 'default'], [1180, '1180'], [1024, '1024']] as const) {
        await electronApp.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setBounds({ width: w, height: 800 }), width)
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
        if (width >= 1140) await expect(page.locator('.workspace.split')).toBeVisible({ timeout: 30000 })
        else await expect(page.getByRole('tab', { name: '내 논문' })).toBeVisible({ timeout: 30000 })
        if (width >= 1140) await expect(page.locator('.paperpane')).toHaveCSS('opacity', '1')
        if (width === 1440) await expect(page.getByLabel('프로젝트', { exact: true })).toBeVisible()
        else await expect(page.getByRole('button', { name: '프로젝트 목록', exact: true })).toBeVisible()
        await page.screenshot({ path: join(shots, `${label}-${colorScheme}.png`) })
      }
    } finally { await electronApp.close() }
  }
})
