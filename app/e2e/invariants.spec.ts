import { test, expect } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, navTo, openPreset, openProject, plantStaleLock, synthProject } from './helpers'

const CREDIT_1 = 'knuaf-doc · 창업논문 작성 도우미'
const CREDIT_2 = 'prod. 특용작물전공 24학번 김대욱'
const KORDOC = '문서를 읽는 데 필요한 도구를 준비할게요. 처음 한 번은 시간이 조금 걸릴 수 있어요.'

test('reduced motion collapses transitions but keeps the spinner', async () => {
  const { electronApp, page } = await launch({ reducedMotion: 'reduce' })
  const dur = await page.locator('nav .nav-item').first().evaluate((el) => getComputedStyle(el).transitionDuration)
  expect(dur.split(',').map((s) => parseFloat(s)).every((d) => d <= 0.00001)).toBe(true)
  await electronApp.close()
})

test('credit shows on first launch only', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const first = await launch({ userData })
  await expect(first.page.locator(`text=${CREDIT_1}`)).toHaveCount(1)
  await expect(first.page.locator(`text=${CREDIT_2}`)).toHaveCount(1)
  await first.electronApp.close()
  const second = await launch({ userData })
  await expect(second.page.locator(`text=${CREDIT_1}`)).toHaveCount(0)
  await second.electronApp.close()
})

test('hard rules hold across screens', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  // The folder-less state is 내 논문 itself: one folder CTA, and no path entry anywhere on
  // the student-facing screen (the only path input lives in 설정 > 고급).
  await expect(page.locator('h1', { hasText: '내 논문' })).toBeVisible()
  await expect(page.locator('text=논문 작업 폴더를 골라 주세요')).toBeVisible()
  expect(await page.locator('main input[aria-label="폴더 경로"]').count()).toBe(0)
  await openProject(page, root)
  await page.waitForSelector('h1:has-text("내 논문")', { timeout: 30_000 })

  // The primary nav is exactly the five approved destinations — no 그룹 내비, no footer helper.
  const navLabels = await page.locator('nav .nav-item').allInnerTexts()
  expect(navLabels.map((t) => t.trim())).toEqual(['내 논문', '자료', '결과물', '점검', '설정'])

  // 내 논문 controls must not ask for JSON/model/path input either (same rule as 도구).
  expect(await page.locator('.chat-seg').count()).toBe(0)
  expect(await page.locator('main input[aria-label="폴더 경로"]').count()).toBe(0)
  const chatCtrls = (await page.locator('main label, main .field > span, main button').allInnerTexts()).join('\n')
  expect(chatCtrls).not.toMatch(/JSON|모델/)

  // The independent-review notice must reach the publish/save points even when the student
  // never opens 점검 — the notice lives at the moment of the attempt, not behind a screen.
  await navTo(page, '결과물')
  await expect(page.locator('text=독립검토 미실행')).toBeVisible()
  // 파일 만들기: 제출용 버튼은 관문이 막혀도 활성 — 경고가 관문이지 버튼 잠금이 아니다(#4).
  const submitBtn = page.locator('button:has-text("제출용 파일 만들기")')
  await expect(submitBtn).toBeEnabled()
  await submitBtn.click()
  await expect(page.locator('text=독립검토 미실행').first()).toBeVisible()
  // The same notice reaches the 고급 도구 발행 지점 (설정 > 고급 도구 > 검토본보내기).
  await navTo(page, '설정')
  await openPreset(page, 'tools:export')
  await page.selectOption('details[data-preset="tools:export"] select', 'submission_candidate')
  await expect(page.locator('details[data-preset="tools:export"] >> text=독립검토 미실행')).toBeVisible()
  const labels = (await page.locator('details[data-preset="tools:export"] label, details[data-preset="tools:export"] .field > span').allInnerTexts()).join('\n')
  expect(labels).not.toMatch(/JSON|모델/)

  await navTo(page, '점검')
  await page.waitForSelector('h1:has-text("점검")', { timeout: 30_000 })

  // four lanes by name, no percentage progress, no single done badge
  for (const t of ['자동 점검', '다른 사람 검토', '파일 확인', '교수님 승인']) await expect(page.getByText(t, { exact: true })).toBeVisible()
  expect(await page.locator('[role=progressbar], progress').count()).toBe(0)
  expect(await page.locator('main').innerText()).not.toMatch(/\d+\s*%/)
  await expect(page.locator('text=아직 독립검토 기록이 없어요')).toBeVisible()
  expect(await page.locator('button:has-text("완료")').count()).toBe(0)

  // no skip / N-A controls anywhere on 점검
  expect(await page.locator('button:has-text("건너뛰기"), button:has-text("해당 없음")').count()).toBe(0)

  // 논문 차례: read-only — the 사이드바 TOC opens the section in a Sheet, never an editor.
  await expect(page.locator('nav .toc-head')).toHaveText('논문 차례')
  await page.locator('nav .toc-item').first().click()
  await expect(page.locator('dialog').getByText('읽기 전용').first()).toBeVisible()
  expect(await page.locator('dialog textarea, dialog [contenteditable="true"], main textarea, main [contenteditable="true"]').count()).toBe(0)
  await page.click('dialog >> button[aria-label="닫기"]')

  // troubleshoot (설정 > 문제 해결): release only for a stale same-host lock; sanctioned Kordoc sentence only
  await navTo(page, '설정')
  await openPreset(page, 'fix:lock')
  await openPreset(page, 'fix:kordoc')
  await expect(page.locator(`text=${KORDOC}`)).toHaveCount(1)
  await expect(page.locator('button:has-text("잠금 해제")')).toBeDisabled()
  plantStaleLock(root)
  await page.click('text=다시 진단')
  await expect(page.locator('text=남은 잠금')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('button:has-text("잠금 해제")')).toBeEnabled()
  await electronApp.close()
})
