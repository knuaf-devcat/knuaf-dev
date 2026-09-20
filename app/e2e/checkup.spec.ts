// Electron e2e for the 점검 screen — 한글 마무리 항목의 '방법 보기' 시트.
import { test, expect } from '@playwright/test'
import { launch, navTo, openProject, synthProject } from './helpers'

// GUI-11 — "방법 보기"는 대상·메뉴 순서·확인 기준을 줘야 한다. "한글에서 직접 확인" 한
// 문장으로는 따라 할 수 없다. 수치는 학교 지침 그대로다(여백 위20/아래15/머리15/꼬리15/
// 좌30/우30 mm, 글꼴 신명조 — gg_core.user_finish_task_list).
test('the how sheet gives the menu path and the school values', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await navTo(page, '점검')
    await page.waitForSelector('h1:has-text("점검")', { timeout: 30_000 })
    // 닫힌 Sheet 도 <dialog>로 DOM 에 남으므로 open 인 것만 본다.
    const sheet = page.locator('dialog[open]')
    // 여백 — 쪽 설정 경로와 여섯 수치
    await page.locator('.item:has-text("여백 맞추기") button:has-text("방법 보기")').click()
    await expect(sheet).toContainText('쪽 설정')
    for (const v of ['위 20', '아래 15', '머리 15', '꼬리 15', '왼쪽 30', '오른쪽 30']) {
      await expect(sheet).toContainText(v)
    }
    await page.click('dialog[open] >> button[aria-label="닫기"]')
    // 글꼴 — 신명조와 확인 위치(글꼴 상자)
    await page.locator('.item:has-text("글꼴 신명조 확인") button:has-text("방법 보기")').click()
    await expect(sheet).toContainText('신명조')
    await expect(sheet).toContainText('글꼴 상자')
  } finally {
    await electronApp.close()
  }
})
