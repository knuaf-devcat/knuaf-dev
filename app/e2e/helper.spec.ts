import { test, expect } from '@playwright/test'
import { existsSync, readdirSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { findExecutable } from '../src/main/agent'
import { launch, navTo, openProject, synthProject } from './helpers'
import { writeCliShim } from './fixtures/fake-codex'

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
  await expect(sheet.locator('text=터미널에 AI 도우미 실행을 요청했어요')).toBeVisible({ timeout: 30_000 })
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


/**
 * 실기기 UI-D01 — Codex 를 열었는데 성공 안내가 "브라우저에 Claude 로그인 창이 떠요" 였다.
 * PATH 첫 자리에 `--version` 만 답하는 가짜 codex 를 두고(CI 에도 도는 길) Codex 로 연다.
 * 이 기기에 claude 가 있으면 고르는 화면이 뜨므로 그때는 "Codex 열기" 를 누른다.
 */
test('Codex 로 열면 성공 안내가 Claude 로그인을 말하지 않는다 (UI-D01, dry run)', async () => {
  const bindir = mkdtempSync(join(tmpdir(), 'kd-bin-'))
  writeCliShim(bindir, 'codex', 'echo "codex-cli 0.0.0-test"', 'echo codex-cli 0.0.0-test')
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const root = synthProject({ withContent: false })
  const { electronApp, page } = await launch({
    userData,
    env: { PATH: [bindir, process.env.PATH ?? ''].join(delimiter), KNUAF_DRY_LAUNCH: '1', KNUAF_AGENT_PATH_ONLY: '1' }
  })
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    await navTo(page, '설정')
    await page.click('button:has-text("앱 밖 터미널로 도우미 열기")')
    const sheet = page.locator('dialog.sheet[open]').last()
    await expect(sheet).toBeVisible()
    const done = sheet.locator('text=터미널에 AI 도우미 실행을 요청했어요')
    const codexBtn = sheet.locator('button:has-text("Codex 열기")')
    await expect(done.or(codexBtn)).toBeVisible({ timeout: 30_000 })
    if (await codexBtn.isVisible()) await codexBtn.click()
    await expect(done).toBeVisible({ timeout: 30_000 })
    await expect(sheet).toContainText('ChatGPT')
    await expect(sheet).toContainText('터미널에 오류가 보이면')
    await expect(sheet, 'Codex 를 열었는데 Claude 로그인을 안내한다').not.toContainText('Claude 로그인')
    // 실제로 codex 로 열었는지 — 실행물이 가짜 codex 를 부른다.
    const launchDir = join(userData, 'launch')
    const scripts = readdirSync(launchDir)
    expect(scripts.length).toBe(1)
    expect(readFileSync(join(launchDir, scripts[0]), 'utf-8')).toContain(bindir)
  } finally {
    await electronApp.close()
  }
})
