import { test, expect } from '@playwright/test'
import { launch, openProject, plantStaleLock, synthProject } from './helpers'

test('open a project, see four lanes, export a draft, unlock a stale lock', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await page.waitForSelector('h1:has-text("대시보드")', { timeout: 30_000 })
  await expect(page.locator('text=1. 기계검사')).toBeVisible()
  await expect(page.locator('text=2. 내용검토(독립)')).toBeVisible()
  await expect(page.locator('text=3. 실제 출력검토')).toBeVisible()
  await expect(page.locator('text=4. 교수 승인')).toBeVisible()
  await expect(page.locator('text=독립검토 미실행')).toBeVisible()
  await page.click('nav >> text=검사 결과')
  await expect(page.locator('code', { hasText: 'school_profile' }).first()).toBeVisible()
  await page.click('nav >> text=산출물')
  await page.selectOption('select', 'draft')
  await page.click('button:has-text("발행하기")')
  await expect(page.locator('text=발행됨')).toBeVisible({ timeout: 30_000 })
  // plant a stale lock and release it from the troubleshoot screen
  plantStaleLock(root)
  await page.click('nav >> text=문제 해결')
  await page.click('text=다시 진단')
  await expect(page.locator('text=남은 잠금')).toBeVisible({ timeout: 30_000 })
  await page.click('button:has-text("잠금 해제")')
  await page.click('dialog >> button:has-text("해제")')
  await expect(page.locator('text=잠금을 해제했어요')).toBeVisible({ timeout: 30_000 })
  await electronApp.close()
})
