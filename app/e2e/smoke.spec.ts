import { test, expect } from '@playwright/test'
import { launch, navTo, openPreset, openProject, plantStaleLock, synthProject } from './helpers'

test('open a project, see four lanes, export a draft, unlock a stale lock', async () => {
  // 잠금 해제는 사이드카를 새로 띄운다 — 전수 후반부(여러 앱을 띄운 뒤)에는 이 한 자리가
  // 오래 걸려 기본 90초 예산을 넘긴 적이 있다(단독 실행은 늘 5초 안). 그래서 예산도 함께 늘린다.
  test.setTimeout(240_000)
  const root = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await page.waitForSelector('.chat-pane', { timeout: 30_000 })
  await navTo(page, '점검')
  await page.waitForSelector('[data-screen="checkup"]', { timeout: 30_000 })
  // Four lanes, separately, by name — never one merged badge.
  await expect(page.getByText('자동 점검', { exact: true })).toBeVisible()
  await expect(page.getByText('다른 사람 검토', { exact: true })).toBeVisible()
  await expect(page.getByText('파일 확인', { exact: true })).toBeVisible()
  await expect(page.getByText('교수님 승인', { exact: true })).toBeVisible()
  await expect(page.locator('text=아직 독립검토 기록이 없어요')).toBeVisible()
  // The row names the check in 한국어; check_id lives behind 자세히. school_profile is only
  // ever emitted blocked (gg_core.py:1552), so the row is always there to be found.
  // v5 에서 검사 행은 **자동 점검 행의 "자세히"** 안에 있다(시안 ⑫) — 먼저 펼친다.
  await page.locator('[data-screen="checkup"] summary:has-text("자세히")').first().click()
  await expect(page.locator('text=학교 규칙 등록').first()).toBeVisible()
  // 결과물 > 파일 만들기 — 검토본은 관문 없이 만든다.
  await navTo(page, '결과물')
  await page.click('.make-row:has-text("검토본 만들기") button')
  await expect(page.locator('text=검토본을 만들었어요')).toBeVisible({ timeout: 30_000 })
  // plant a stale lock and release it from 설정 > 문제 해결
  plantStaleLock(root)
  await navTo(page, '설정')
  await openPreset(page, 'fix:lock')
  await page.click('text=다시 진단')
  await expect(page.locator('text=남은 잠금')).toBeVisible({ timeout: 30_000 })
  await page.click('button:has-text("잠금 해제")')
  // 확인 창은 설정 시트 **안에** 겹쳐 뜬다 — 가장 위(마지막) dialog 의 단추를 누른다.
  await page.locator('dialog[open]').last().getByRole('button', { name: '해제', exact: true }).click()
  // 잠금 해제는 사이드카를 새로 띄우는 일이라 **전수 실행 후반부**에는 30초를 넘긴 적이 있다
  // (단독 실행에서는 늘 통과 — 2026-10-18 전수 2회 중 2회 실패·단독 2/2 통과). 제품이 아니라
  // 그 자리의 대기 시간 문제라 여유를 준다.
  await expect(page.locator('text=잠금을 해제했어요')).toBeVisible({ timeout: 120_000 })
  await electronApp.close()
})
