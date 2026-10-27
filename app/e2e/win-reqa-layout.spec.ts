import { expect, test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, paperReady, splitReady, synthProject } from './helpers'
import { fakeCodexEnv, scratch, seedChat } from './fixtures/fake-codex'
import { CHAT, TITLEBAR } from '../src/renderer/src/copy'

async function composerInsideWindow(page: Page): Promise<void> {
  const textarea = page.getByRole('textbox', { name: CHAT.placeholder })
  // isVisible alone accepts an element below the viewport (QA-05).
  const geometry = await textarea.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, height: innerHeight,
      hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }
  })
  expect(geometry.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(0)
  expect(geometry.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.height)
  expect(geometry.hit, '입력칸 가운데를 실제로 누를 수 있어야 한다').toBe(true)
  await textarea.click()
  await expect(textarea).toBeFocused()
}

test('QA-05: 본문·표와 긴 대화를 재열어도 두 칸 입력칸이 창 안에 남는다', async () => {
  const root = synthProject()
  writeFileSync(join(root, 'sections', '01.md'), '# Ⅰ. 머리말\n\n' +
    '저장된 본문 문단입니다.\n\n'.repeat(30) + '| 항목 | 값 |\n| --- | --- |\n' +
    '| 재배 면적 | 600평 |\n'.repeat(25), 'utf-8')
  const dir = scratch()
  const userData = join(dir, 'userdata')
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  seedChat(root, [
    { id: 'u-long', role: 'user', text: '저장된 긴 사용자 답변입니다. '.repeat(250), at: new Date().toISOString(), delivery: 'sent' },
    { id: 'a-long', role: 'assistant', text: '저장된 답변입니다.\n\n'.repeat(60), at: new Date().toISOString() }
  ])
  // 정상 종료 후 같은 userData/프로젝트의 저장 대화를 다시 읽는다.
  const first = await launch({ userData, env })
  try { await openProject(first.page, root, splitReady) } finally { await first.electronApp.close() }
  const { electronApp, page } = await launch({ userData, env })
  try {
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 800 }))
    await openProject(page, root, splitReady)
    await paperReady(page, '저장된 본문 문단입니다.')
    await expect(page.locator('.paperpane table')).toBeVisible()
    await expect(page.locator('.chat-msg.user')).toContainText('저장된 긴 사용자 답변')
    await composerInsideWindow(page)
    await page.getByRole('button', { name: TITLEBAR.paperClose }).click()
    await expect(page.locator('.workspace.solo')).toBeVisible()
    await composerInsideWindow(page)
    await page.getByRole('tab', { name: TITLEBAR.segPaper, exact: true }).click()
    await splitReady(page)
    await composerInsideWindow(page)
    const textarea = page.getByRole('textbox', { name: CHAT.placeholder })
    await textarea.fill('복구된 초안\n'.repeat(30))
    await composerInsideWindow(page)
    await textarea.fill('')
    await composerInsideWindow(page)
  } finally { await electronApp.close() }
})
