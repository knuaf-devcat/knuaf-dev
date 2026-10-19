/**
 * 형님 윈도우 실기 피드백(2026-10-19) — 실제 Electron 앱으로 밟는 장면.
 *
 * 새 논문(정본 tasks 에는 한글 마무리뿐 — 도우미가 기다리는 질문 0건)에서 도우미가 정본 형식을
 * 조금 벗어난 질문(굵은 글씨·윈도우 줄바꿈)을 보내도 질문 카드가 뜨고, 대화 본문에 별표가 남지 않는다.
 * 예전에는 `questionProject()` 처럼 user_owned 작업을 손으로 넣어야만 카드가 떴다.
 */
import { expect, test } from '@playwright/test'
import { launch, openProject, synthProject } from './helpers'
import { QUESTION_1, fakeCodexEnv, questionMessage, scratch, seedChat } from './fixtures/fake-codex'

const BOLD_CRLF = QUESTION_1
  .replace('[Q3-2] Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요', '**[Q3-2] Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요**')
  .replace(/\n/g, '\r\n')

test('새 논문에서도 질문 카드가 뜨고, 굵은 글씨는 별표 없이 보인다 (형님 윈도우 실기)', async () => {
  const dir = scratch()
  const root = synthProject()            // user_owned 작업 없음 — 새 논문의 실제 상태
  seedChat(root, [questionMessage('a-q1', BOLD_CRLF)])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    await expect(page.locator('.qcard'), '기다리는 질문 0건이라 카드가 안 떴다').toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.qcard .qcard-q')).toHaveText('지금 블루베리를 주로 어디에 팔고 있나요?')
    const body = page.locator('.chat-msg.assistant .prose').first()
    await expect(body.locator('strong')).toHaveText('[Q3-2] Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요')
    await expect(body, '별표가 글자로 남았다').not.toContainText('**')
  } finally {
    await electronApp.close()
  }
})
