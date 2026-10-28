import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { launch } from './helpers'
import { fakeCodexEnv, replyFile, scratch } from './fixtures/fake-codex'

const suggestions = [
  ['새 창업 논문 시작', '새 창업 논문을 쓰고 싶어요. 제 창업 아이템부터 이야기할게요.'],
  ['쓰던 원고(docx) 이어 쓰기', '이미 쓰던 docx 원고를 바탕으로 창업 논문을 이어 쓰고 싶어요.'],
  ['제출 전 점검만', '작성한 논문을 제출하기 전에 점검하고 싶어요.'],
] as const

for (const [label, prompt] of suggestions) {
  test(`${label}: 편집한 첫 요청이 폴더 선택 뒤 한 번 전달된다`, async () => {
    const dir = scratch()
    const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, '확인했어요') })
    const { electronApp, page } = await launch({ env })
    try {
      await electronApp.evaluate(({ app }, docs) => app.setPath('documents', docs), dir)
      await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨', { timeout: 30000 })
      const box = page.getByRole('textbox', { name: '답변을 입력하세요' })
      await page.getByRole('button', { name: label, exact: true }).click()
      await expect(box).toHaveValue(prompt)
      await expect(box).toBeFocused()
      await expect(page.getByText('논문 파일을 어디에 둘까요?')).toHaveCount(0)
      await expect(page.locator('.chat-msg')).toHaveCount(0)
      await expect(page.locator('dialog[open]')).toHaveCount(0)
      const edited = `${prompt} 주제는 딸기 농장입니다.`
      await box.fill(edited)
      await page.getByRole('button', { name: '보내기', exact: true }).click()
      await expect(page.getByText('논문 파일을 어디에 둘까요?')).toBeVisible()
      await expect(page.locator('.folder-message')).toHaveText(edited)
      await page.getByRole('textbox', { name: '논문 이름' }).fill('딸기 논문')
      await page.getByRole('button', { name: /앱이 만들어 둘게요/ }).click()
      await expect(page.getByText('확인했어요')).toBeVisible({ timeout: 30000 })
      await expect(page.locator('.chat-msg.user')).toHaveCount(1)
      await expect(page.locator('.chat-msg.user')).toHaveText(edited)
    } finally { await electronApp.close() }
  })
}

test('기존에 입력한 글을 제안 단추가 지우지 않는다', async () => {
  const dir = scratch()
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(dir, 'bin')) })
  try {
    const box = page.getByRole('textbox', { name: '답변을 입력하세요' })
    await box.fill('딸기 농장에 관해 쓰고 싶어요.')
    await page.getByRole('button', { name: '새 창업 논문 시작' }).click()
    await expect(box).toHaveValue(`딸기 농장에 관해 쓰고 싶어요.\n${suggestions[0][1]}`)
  } finally { await electronApp.close() }
})
