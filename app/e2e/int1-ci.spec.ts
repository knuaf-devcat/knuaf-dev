import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './helpers'
import { fakeCodexEnv, replyFile, scratch } from './fixtures/fake-codex'

for (const barrier of ['acceptance', 'draft-cleanup'] as const) {
  test(`메뉴 첫 메시지의 ${barrier} 응답이 늦어도 이미 끝난 답변을 되돌리지 않는다`, async () => {
    const dir = scratch()
    const root = join(dir, '기존 논문')
    mkdirSync(root)
    const log = join(dir, 'turns.jsonl')
    const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_TURN_LOG: log, FAKE_CODEX_REPLY: replyFile(dir, '메뉴로 연 답변') })
    const { electronApp, page } = await launch({ onboarded: false, env })
    try {
      await electronApp.evaluate(({ ipcMain }, hold) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
        const entered = Promise.withResolvers<void>()
        const held = Promise.withResolvers<void>()
        const cleanup = Promise.withResolvers<void>()
        Object.assign(globalThis, { sendRaceEntered: entered.promise, sendRaceRelease: held.resolve, sendRaceCleanup: cleanup.promise })
        for (const channel of ['chat:send', 'chat:set-draft']) {
          const original = handlers.get(channel)!
          handlers.set(channel, async (...args) => {
            const result = await original(...args)
            const isCleanup = channel === 'chat:set-draft' && args[3] !== undefined
            if ((hold === 'acceptance' && channel === 'chat:send') || (hold === 'draft-cleanup' && isCleanup)) {
              entered.resolve()
              await held.promise
            }
            if (isCleanup) cleanup.resolve()
            return result
          })
        }
      }, barrier)
      await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨')
      await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('기존 논문 이어 쓰기')
      await page.getByRole('button', { name: '보내기', exact: true }).click()
      await expect(page.getByText('논문 파일을 어디에 둘까요?')).toBeVisible()
      await electronApp.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].webContents.send('menu', { type: 'open-recent', root: target }), root)
      await electronApp.evaluate(async () => await Reflect.get(globalThis, 'sendRaceEntered'))
      // 실제 서버의 답변·완료 알림이 먼저 도착한다. 보류한 응답만 그 뒤에 돌려준다.
      await expect(page.getByText('메뉴로 연 답변', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '중단', exact: true })).toHaveCount(0)
      await electronApp.evaluate(() => Reflect.get(globalThis, 'sendRaceRelease')())
      await electronApp.evaluate(async () => await Reflect.get(globalThis, 'sendRaceCleanup'))
      await page.evaluate(async (target) => {
        await window.knuaf.chat.draft(target)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }, root)
      await expect(page.getByText('메뉴로 연 답변', { exact: true })).toBeVisible()
      await expect(page.getByText('보내는 중', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '중단', exact: true })).toHaveCount(0)
      await expect(page.locator('.chat-msg.user')).toHaveText('기존 논문 이어 쓰기')
      const saved = JSON.parse(readFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), 'utf8'))
      expect(saved.state).toBe('idle')
      expect(saved.messages.filter((m: { role: string }) => m.role === 'assistant').map((m: { text: string }) => m.text)).toEqual(['메뉴로 연 답변'])
      expect(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([{}])
    } finally { await electronApp.close() }
  })
}
