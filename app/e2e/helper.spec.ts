import { test, expect } from '@playwright/test'
import { existsSync, readdirSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'

// KNUAF_DRY_LAUNCH=1: the .command file is written but Terminal is not opened.
test('AI helper button installs the skill and writes a launch script (dry run)', async () => {
  process.env.KNUAF_DRY_LAUNCH = '1'
  const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const root = synthProject({ withContent: false })
  const { electronApp, page } = await launch({ userData })
  // point HOME at a temp dir so the real ~/.claude/skills is untouched
  await electronApp.evaluate(({ app }, h) => { app.setPath('home', h) }, home)
  await openProject(page, root)
  await page.waitForSelector('button:has-text("AI 도우미 열기")', { timeout: 30_000 })
  await page.click('nav >> button:has-text("AI 도우미 열기")')
  const sheet = page.locator('dialog.sheet')
  await expect(sheet).toBeVisible()
  // this Mac has claude and codex → chooser appears; pick Claude
  const claudeBtn = sheet.locator('button:has-text("Claude Code 열기")')
  await claudeBtn.waitFor({ timeout: 30_000 })  // status probe is async (claude --version)
  await claudeBtn.click()
  await expect(sheet.locator('text=터미널 창에서 AI 도우미가 열렸어요')).toBeVisible({ timeout: 30_000 })
  const skillDir = join(home, '.claude', 'skills', 'knuaf-doc')
  expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
  expect(existsSync(join(skillDir, 'scripts', 'gg_core.py'))).toBe(true)
  const launchDir = join(userData, 'launch')
  const scripts = readdirSync(launchDir).filter((f) => f.endsWith('.command'))
  expect(scripts.length).toBeGreaterThan(0)
  const body = readFileSync(join(launchDir, scripts[0]), 'utf-8')
  expect(body).toContain("'시작하기'")
  expect(body).toContain(root)
  await electronApp.close()
})
