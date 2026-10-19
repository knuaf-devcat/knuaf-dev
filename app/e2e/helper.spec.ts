import { test, expect } from '@playwright/test'
import { existsSync, readdirSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findExecutable } from '../src/main/agent'
import { launch, navTo, openProject, synthProject } from './helpers'

// KNUAF_DRY_LAUNCH=1: the launch script is written but the terminal is not opened.
// 확장자는 플랫폼이 정한다 — 맥은 `.command`(Terminal), 윈도우는 `.cmd`(배치).
test('external terminal button installs the skill into the project and writes a launch script (dry run)', async () => {
  // The chooser only offers Claude when the CLI is actually installed, so this
  // whole flow is a developer-machine test. CI runners have no agent CLI.
  test.skip(findExecutable('claude', process.env) === null, 'claude is not installed on this machine')
  process.env.KNUAF_DRY_LAUNCH = '1'
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const root = synthProject({ withContent: false })
  const { electronApp, page } = await launch({ userData })
  await openProject(page, root)
  // opening lands on "내 논문" once open() settles; wait for it before navigating away
  await page.waitForSelector('.chat-pane', { timeout: 30_000 })
  await navTo(page, '설정')
  await page.click('button:has-text("앱 밖 터미널로 도우미 열기")')
  // 설정 시트 위에 도우미 시트가 겹쳐 뜬다 — 가장 위(마지막) dialog 가 도우미 시트다.
  const sheet = page.locator('dialog.sheet[open]').last()
  await expect(sheet).toBeVisible()
  // claude is installed (checked above) → chooser appears; pick Claude
  const claudeBtn = sheet.locator('button:has-text("Claude Code 열기")')
  await claudeBtn.waitFor({ timeout: 30_000 }) // status probe is async (claude --version)
  await claudeBtn.click()
  await expect(sheet.locator('text=터미널 창에서 AI 도우미가 열렸어요')).toBeVisible({ timeout: 30_000 })
  const skillDir = join(root, '.claude', 'skills', 'knuaf-dev')
  expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
  expect(existsSync(join(skillDir, 'scripts', 'gg_core.py'))).toBe(true)
  const launchDir = join(userData, 'launch')
  const win = process.platform === 'win32'
  const scripts = readdirSync(launchDir).filter((f) => f.endsWith(win ? '.cmd' : '.command'))
  expect(scripts.length).toBeGreaterThan(0)
  const body = readFileSync(join(launchDir, scripts[0]), 'utf-8')
  // 인용 규칙도 플랫폼마다 다르다 — 맥은 `'…'`, 윈도우(cmd)는 `"…"`.
  expect(body).toContain(win ? '"시작하기' : "'시작하기")
  expect(body).toContain('작업 폴더: ')
  expect(body).toContain(root)
  await electronApp.close()
})
