import { test, expect } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, navTo, openProject, python, scripts, synthProject } from './helpers'

const freshUserData = () => { const d = mkdtempSync(join(tmpdir(), 'kd-ud-')); mkdirSync(d, { recursive: true }); return d }

test('reopen a project from the recent-folder card (second visit)', async () => {
  const userData = freshUserData()
  const root = synthProject()
  const first = await launch({ userData })
  await openProject(first.page, root)
  await first.page.waitForSelector('h1:has-text("내 논문")', { timeout: 30_000 })
  await first.electronApp.close()

  const second = await launch({ userData })
  // folder-less 내 논문 — the card is the real second-visit entry path (picker cannot be driven).
  await expect(second.page.locator('text=논문 작업 폴더를 골라 주세요')).toBeVisible()
  await second.page.locator('.project').first().click()
  await second.page.waitForSelector('h1:has-text("내 논문")', { timeout: 30_000 })
  await expect(second.page.locator('nav .project-chip .name')).toContainText(basename(root))
  // 칩에는 경로가 노출되지 않는다 — basename만 (전체 경로는 title 속성)
  await expect(second.page.locator('nav .project-chip .name')).not.toContainText(dirname(root))
  await expect(second.page.locator('nav .toc-head')).toHaveText('논문 차례')
  await second.electronApp.close()
})

test('legacy terminal helper modes migrate to chat without stranding the student', async () => {
  const userData = freshUserData()
  // 인앱 터미널 모드는 제거됐다 — 저장된 옛 값은 공급자를 보존한 채 채팅으로 옮긴다.
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ recent: [], codex_terminal: true }), 'utf-8')
  const { electronApp, page } = await launch({ userData })
  await navTo(page, '설정')
  await expect(page.locator('input[name="helper-chat"]').nth(0)).toBeChecked()
  // migrated value lands on disk at the next save — pick the other provider and back
  await page.locator('input[name="helper-chat"]').nth(1).check()
  await page.locator('input[name="helper-chat"]').nth(0).check()
  await electronApp.close()
  expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf-8')).helper_mode).toBe('codex-chat')

  // claude-term 은 claude-chat 으로 — 공급자 선택이 codex 로 되돌아가면 안 된다.
  const userData2 = freshUserData()
  writeFileSync(join(userData2, 'settings.json'), JSON.stringify({ recent: [], helper_mode: 'claude-term' }), 'utf-8')
  const { electronApp: app2, page: page2 } = await launch({ userData: userData2 })
  await navTo(page2, '설정')
  await expect(page2.locator('input[name="helper-chat"]').nth(1)).toBeChecked()
  await app2.close()
})

test('helper choice persists across relaunch', async () => {
  const userData = freshUserData()
  const first = await launch({ userData })
  await navTo(first.page, '설정')
  await first.page.locator('input[name="helper-chat"]').nth(1).check()
  await first.electronApp.close()

  const second = await launch({ userData })
  await navTo(second.page, '설정')
  await expect(second.page.locator('input[name="helper-chat"]').nth(1)).toBeChecked()
  await second.electronApp.close()
})

// 채팅 선택지는 공급자를 이름으로 알려야 한다 — "앱이 알아서 해준다"로 읽히면 안 된다.
test('chat helper pick names ChatGPT and persists claude-chat', async () => {
  const userData = freshUserData()
  const { electronApp, page } = await launch({ userData })
  await navTo(page, '설정')
  await expect(page.locator('input[name="helper-chat"]').nth(0)).toBeChecked()
  await expect(page.locator('text=ChatGPT (Codex)')).toBeVisible()
  await page.locator('input[name="helper-chat"]').nth(1).check()
  await electronApp.close()
  expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf-8')).helper_mode).toBe('claude-chat')
})

// 잘못 연 폴더가 첫 화면에 영원히 남으면 안 된다 — 폴더가 디스크에 있어도 목록에서 뺄 수 있다.
test('an existing folder can be removed from the recent list', async () => {
  const userData = freshUserData()
  const root = synthProject()
  const first = await launch({ userData })
  await openProject(first.page, root)
  await first.page.waitForSelector('h1:has-text("내 논문")', { timeout: 30_000 })
  await first.electronApp.close()

  const second = await launch({ userData })
  const card = second.page.locator('.project', { hasText: basename(root) })
  await expect(card).toBeVisible()
  const rm = card.locator('button', { hasText: '목록에서 제거' })
  await expect(rm).toBeVisible()
  await rm.click()
  await expect(second.page.locator('.project')).toHaveCount(0)
  await second.electronApp.close()
  // 설정에도 반영된다 — 폴더 자체는 지우지 않았다.
  expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf-8')).recent).toEqual([])
})

// 도우미가 하위 폴더에 init하면 앱은 <root>/project.json을 못 찾는다 — 빈 화면으로
// 두지 않고 어디에 만들었는지 알려 준다.
test('a nested project made by the helper is named, not a silent empty screen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-e2e-'))
  const sub = join(root, 'knuaf-work')
  mkdirSync(sub)
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'init', sub], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await expect(page.locator('text=도우미가 다른 폴더에 논문을 만들었어요')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('text=knuaf-work').first()).toBeVisible()
  await electronApp.close()
})
