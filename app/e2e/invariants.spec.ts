import { test, expect } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, openProject, plantStaleLock, synthProject } from './helpers'

const CREDIT_1 = 'knuaf-doc · 창업논문 작성 도우미'
const CREDIT_2 = 'prod. 특용작물전공 24학번 김대욱'
const KORDOC = '문서를 읽는 데 필요한 도구를 준비할게요. 처음 한 번은 시간이 조금 걸릴 수 있어요.'

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
  await openProject(page, root)
  await page.waitForSelector('h1:has-text("대시보드")', { timeout: 30_000 })

  // four lanes, no percentage progress, banner first
  for (const t of ['1. 기계검사', '2. 내용검토(독립)', '3. 실제 출력검토', '4. 교수 승인']) await expect(page.locator(`text=${t}`)).toBeVisible()
  expect(await page.locator('[role=progressbar], progress').count()).toBe(0)
  expect(await page.locator('main').innerText()).not.toMatch(/\d+\s*%/)
  await expect(page.locator('text=독립검토 미실행')).toBeVisible()

  // checks: no skip / N-A controls
  await page.click('nav >> text=검사 결과')
  await expect(page.locator('text=독립검토 미실행')).toBeVisible()
  expect(await page.locator('button:has-text("건너뛰기"), button:has-text("해당 없음")').count()).toBe(0)

  // sections: read-only
  await page.click('nav >> text=절 목록')
  await page.click('button:has-text("미리보기")')
  expect(await page.locator('main textarea, main [contenteditable="true"]').count()).toBe(0)
  await expect(page.locator('text=읽기 전용').first()).toBeVisible()
  await page.click('dialog >> button[aria-label="닫기"]')

  // students never see JSON / model pickers as inputs
  await page.click('nav >> text=산출물')
  const labels = (await page.locator('main label, main .field > span').allInnerTexts()).join('\n')
  expect(labels).not.toMatch(/JSON|모델/)

  // troubleshoot: release only for a stale same-host lock; sanctioned Kordoc sentence only
  await page.click('nav >> text=문제 해결')
  await expect(page.locator(`text=${KORDOC}`)).toHaveCount(1)
  await expect(page.locator('button:has-text("잠금 해제")')).toBeDisabled()
  plantStaleLock(root)
  await page.click('text=다시 진단')
  await expect(page.locator('text=남은 잠금')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('button:has-text("잠금 해제")')).toBeEnabled()
  await electronApp.close()
})
