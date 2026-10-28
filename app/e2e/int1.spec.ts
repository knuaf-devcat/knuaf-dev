import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import { fakeCodexEnv, questionMessage, questionProject, QUESTION_2, replyFile, scratch, seedChat, userDataWith } from './fixtures/fake-codex'

const BOX = 'textarea[aria-label="답변을 입력하세요"]'
const readDraft = (root: string) => {
  const file = join(root, '.knuaf-gui', 'draft.txt')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

for (const outcome of ['prepare-failure', 'accepted', 'accepted-edited'] as const) {
  test(`INT1-01: 첫 메시지 ${outcome} 응답 전에 B로 옮겨도 A의 글과 B의 초안을 지킨다`, async () => {
    const dir = scratch()
    const a = synthProject({ withContent: false })
    const b = synthProject({ withContent: false })
    seedChat(a, [{ id: 'old', role: 'assistant', text: '앞 대화입니다.', at: new Date().toISOString() }])
    const chatFile = join(a, '.knuaf-gui', 'chat-codex.json')
    writeFileSync(chatFile, JSON.stringify({ ...JSON.parse(readFileSync(chatFile, 'utf8')), sessionId: 't-fake' }))
    writeFileSync(join(a, '.knuaf-gui', 'draft.txt'), 'A에서 쓰던 초안')
    const threads = join(dir, 'threads.json')
    writeFileSync(threads, JSON.stringify({ threadId: 't-fake', model: 'gpt-sol', effort: 'high' }))
    const log = join(dir, 'turns.jsonl')
    const env = fakeCodexEnv(join(dir, 'bin'), {
      FAKE_CODEX_THREAD_STATE: threads, FAKE_CODEX_TURN_LOG: log,
      FAKE_CODEX_EPHEMERAL_FAIL_TIMES: outcome === 'prepare-failure' ? '99' : '0',
      FAKE_CODEX_REPLY: replyFile(dir, '첫 메시지를 받았어요.')
    })
    const userData = userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' }, chat_models: { codex: null } })
    const { electronApp, page } = await launch({ userData, env })
    try {
      await electronApp.evaluate(({ dialog, ipcMain }, root) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root], bookmarks: [] })
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
        const original = handlers.get('chat:send')!
        const entered = Promise.withResolvers<unknown>()
        const held = Promise.withResolvers<void>()
        Reflect.set(globalThis, 'int1Entered', entered.promise)
        Reflect.set(globalThis, 'int1Release', held.resolve)
        handlers.set('chat:send', async (...args) => {
          // 실제 prepare/전송 핸들러를 실행한다. 오류를 꾸미지 않고 반환 타이밍만 붙잡는다.
          const result = await original(...args)
          entered.resolve(result)
          await held.promise
          return result
        })
      }, a)
      await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨')
      await page.locator(BOX).fill('INT1 보존해야 하는 첫 메시지')
      await page.getByRole('button', { name: '보내기', exact: true }).click()
      await page.getByRole('button', { name: /내 폴더 고르기/ }).click()
      const reply = await electronApp.evaluate(async () => await Reflect.get(globalThis, 'int1Entered')) as { error?: { message: string } }
      if (outcome === 'prepare-failure') expect(reply.error?.message).toContain('기본 모델을 확인하지 못해')
      else expect(reply.error).toBeUndefined()
      if (outcome === 'accepted-edited') await page.locator(BOX).fill('A에서 새로 편집한 초안')
      await openProject(page, b)
      await page.locator(BOX).fill('논문B 초안')
      await electronApp.evaluate(() => Reflect.get(globalThis, 'int1Release')())
      // 같은 IPC 통로의 뒤 왕복까지 끝낸 뒤 원래 논문으로 돌아간다.
      await page.evaluate((root) => window.knuaf.chat.draft(root), a)
      await expect(page.locator(BOX)).toHaveValue('논문B 초안')
      await openProject(page, a)
      const expected = outcome === 'prepare-failure' ? 'A에서 쓰던 초안\nINT1 보존해야 하는 첫 메시지'
        : outcome === 'accepted-edited' ? 'A에서 새로 편집한 초안' : 'A에서 쓰던 초안'
      await expect(page.locator(BOX)).toHaveValue(expected)
      await expect.poll(() => readDraft(a)).toBe(expected)
      await expect.poll(() => readDraft(b)).toBe('논문B 초안')
      const chat = JSON.parse(readFileSync(chatFile, 'utf8')) as { messages: { role: string; text: string }[] }
      const sent = chat.messages.filter((m) => m.role === 'user').map((m) => m.text)
      expect(sent).toEqual(outcome === 'prepare-failure' ? [] : ['INT1 보존해야 하는 첫 메시지'])
      if (outcome === 'prepare-failure') expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('')
    } finally { await electronApp.close() }
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`INT1-02: 질문 카드에서 모델·깊이를 고르고 답변과 직접 입력 초안을 지킨다 (${theme})`, async ({}, testInfo) => {
    const dir = scratch()
    const root = questionProject()
    seedChat(root, [questionMessage()])
    const log = join(dir, 'turns.jsonl')
    const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_TURN_LOG: log, FAKE_CODEX_REPLY: replyFile(dir, QUESTION_2) })
    const userData = userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' } })
    const { electronApp, page } = await launch({ userData, env, colorScheme: theme })
    try {
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1024, height: 768 }))
      await openProject(page, root)
      const card = page.locator('.qcard')
      await expect(card).toBeVisible()
      const question = await card.locator('.qcard-q').innerText()
      const chip = page.getByTitle('이 논문의 도우미')
      await expect(chip).toBeVisible()
      await card.locator('.qopt.free').click()
      const draft = '직접 입력하던 답변은 남겨 주세요'
      await card.locator('.freebox textarea').fill(draft)
      await chip.click()
      const popup = page.locator('.composer-model-host .popover')
      await popup.getByRole('button', { name: /^Sol / }).click()
      await popup.getByLabel('생각 깊이').selectOption('high')
      await page.keyboard.press('1')
      await expect(page.locator('.chat-msg.user')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(card.locator('.qcard-q')).toHaveText(question)
      await expect(card.locator('.freebox textarea')).toHaveValue(draft)
      await expect(chip).toContainText('Sol · 생각 깊이 높게')
      const capture = process.env.KNUAF_INT1_CAPTURE_DIR ?? testInfo.outputPath('captures')
      mkdirSync(capture, { recursive: true })
      await page.screenshot({ path: join(capture, `question-chip-1024-${theme}.png`) })
      await card.getByRole('radio', { name: /온라인 직거래/ }).click()
      await expect(page.locator('.chat-msg.user')).toContainText('2) 온라인 직거래')
      await expect(page.locator('.qcard')).toContainText('임차료는 내년에 한 번 오르나요')
      expect(await page.evaluate((r) => window.knuaf.chat.draft(r), root)).toEqual({ result: draft })
      expect(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ model: 'gpt-sol', effort: 'high' }])
    } finally { await electronApp.close() }
  })

  test(`INT1-03: 25줄 첫 메시지 뒤 폴더 단추를 포인터로 누르고 돌아간다 (${theme})`, async ({}, testInfo) => {
    const dir = scratch()
    const { electronApp, page } = await launch({ env: fakeCodexEnv(join(dir, 'bin')), colorScheme: theme })
    try {
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1024, height: 768 }))
      const text = Array.from({ length: 25 }, (_, i) => `${i + 1}. 딸기 농장 계획에 관한 설명입니다.`).join('\n')
      await page.locator(BOX).fill(text)
      await page.getByRole('button', { name: '보내기', exact: true }).click()
      await page.locator('.folder-message').hover()
      await page.mouse.wheel(0, 2000)
      for (const name of [/앱이 만들어 둘게요/, /내 폴더 고르기/, /^돌아가기$/]) {
        const button = page.getByRole('button', { name })
        const bounds = await button.boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.y).toBeGreaterThanOrEqual(0)
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(768)
        expect(await button.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })).toBe(true)
      }
      const capture = process.env.KNUAF_INT1_CAPTURE_DIR ?? testInfo.outputPath('captures')
      mkdirSync(capture, { recursive: true })
      await page.screenshot({ path: join(capture, `long-first-message-1024-${theme}.png`) })
      await page.getByRole('button', { name: '돌아가기', exact: true }).click()
      await expect(page.locator(BOX)).toHaveValue(text)
      await expect(page.locator('.folder-card')).toHaveCount(0)
    } finally { await electronApp.close() }
  })
}
