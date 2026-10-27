import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './helpers'
import { fakeCodexEnv, replyFile, scratch } from './fixtures/fake-codex'

test('첫 메시지 뒤 자동 폴더를 만들되 같은 이름의 기존 폴더는 보존한다', async () => {
  const dir = scratch()
  const existing = join(dir, 'knuaf-dev', '딸기 논문')
  mkdirSync(existing, { recursive: true })
  writeFileSync(join(existing, '원본.txt'), '보존')
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, '질문입니다') })
  const { electronApp, page } = await launch({ onboarded: false, env })
  try {
    await electronApp.evaluate(({ app, shell }, docs) => {
      app.setPath('documents', docs)
      shell.openPath = async (path) => { Object.assign(globalThis, { folderOpened: path }); return '' }
    }, dir)
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨', { timeout: 30000 })
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('딸기 농장 창업 계획')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('논문 파일을 어디에 둘까요?')).toBeVisible()
    await page.getByRole('textbox', { name: '논문 이름' }).fill('딸기 논문')
    await expect(page.getByText('문서 / knuaf-dev / 딸기 논문')).toBeVisible()
    await page.getByRole('button', { name: /앱이 만들어 둘게요/ }).click()
    await expect(page.getByText('질문입니다')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.chat-msg.user')).toHaveCount(1)
    const created = join(dir, 'knuaf-dev', '딸기 논문 (2)')
    expect(existsSync(created)).toBe(true)
    expect(readFileSync(join(existing, '원본.txt'), 'utf8')).toBe('보존')
    await page.getByRole('button', { name: process.platform === 'darwin' ? 'Finder에서 열기' : '파일 탐색기에서 열기' }).click()
    await expect.poll(() => electronApp.evaluate(() => Reflect.get(globalThis, 'folderOpened'))).toBe(created)
  } finally { await electronApp.close() }
})

test('폴더 이름의 경로 구분자는 작업 폴더 밖으로 나가지 않는다', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const { electronApp, page } = await launch({ env })
  try {
    await electronApp.evaluate(({ app }, docs) => app.setPath('documents', docs), dir)
    const result = await page.evaluate(() => window.knuaf.createProjectFolder('../../밖으로'))
    if ('error' in result) throw new Error(result.error.message)
    expect(result.result.root).toBe(join(dir, 'knuaf-dev', '.. .. 밖으로'))
    expect(existsSync(result.result.root)).toBe(true)
    const long = await page.evaluate(() => window.knuaf.createProjectFolder('가'.repeat(100)))
    if ('error' in long) throw new Error(long.error.message)
    expect(existsSync(long.result.root)).toBe(true)
    expect(Buffer.byteLength(long.result.root.split(/[\\/]/).pop()!.normalize('NFD'))).toBeLessThanOrEqual(200)
  } finally { await electronApp.close() }
})

test('폴더 생성이 실패하면 첫 메시지를 보존하고 다시 선택할 수 있다', async () => {
  const dir = scratch()
  writeFileSync(join(dir, 'knuaf-dev'), '폴더가 아닌 파일')
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await electronApp.evaluate(({ app }, docs) => app.setPath('documents', docs), dir)
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('딸기 창업')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await page.getByRole('button', { name: /앱이 만들어 둘게요/ }).click()
    await expect(page.getByRole('alert')).toContainText('폴더를 만들지 못했어요')
    await expect(page.getByText('딸기 창업', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /내 폴더 고르기/ })).toBeEnabled()
  } finally { await electronApp.close() }
})

test('카드가 떠 있을 때 메뉴로 연 폴더에도 첫 메시지를 전달한다', async () => {
  const dir = scratch()
  const root = join(dir, '기존 논문')
  mkdirSync(root)
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, '메뉴로 연 답변') })
  const { electronApp, page } = await launch({ onboarded: false, env })
  try {
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('기존 논문 이어 쓰기')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('논문 파일을 어디에 둘까요?')).toBeVisible()
    await electronApp.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('menu', { type: 'open-recent', root: path }), root)
    await expect(page.getByText('메뉴로 연 답변')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.chat-msg.user')).toHaveCount(1)
    await expect(page.locator('.chat-msg.user')).toContainText('기존 논문 이어 쓰기')
    await expect.poll(async () => (await page.evaluate(() => window.knuaf.getSettings())).provider_choice?.provider).toBe('codex')
  } finally { await electronApp.close() }
})

test('새 논문 시작을 누르면 폴더 카드와 이전 메시지가 지워진다', async () => {
  const dir = scratch()
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('이전 논문')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('논문 파일을 어디에 둘까요?')).toBeVisible()
    await page.getByRole('button', { name: '새 논문 시작' }).click()
    await expect(page.getByText('어떤 논문을 쓰고 있어요?')).toBeVisible()
    await expect(page.getByRole('textbox', { name: '답변을 입력하세요' })).toHaveValue('')
  } finally { await electronApp.close() }
})

test('폴더 선택 카드는 기본·1180·1024 창에서 표시된다', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const shots = join(process.cwd(), 'test-results', 'folder-shots')
  mkdirSync(shots, { recursive: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    const { electronApp, page } = await launch({ colorScheme, env })
    try {
      await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('딸기 농장 창업 계획')
      await page.getByRole('button', { name: '보내기', exact: true }).click()
      for (const width of [1440, 1180, 1024]) {
        await electronApp.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setBounds({ width: w, height: 800 }), width)
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
        await expect(page.getByText('논문 파일을 어디에 둘까요?')).toBeVisible()
        await page.screenshot({ path: join(shots, `${width}-${colorScheme}.png`) })
      }
    } finally { await electronApp.close() }
  }
})
