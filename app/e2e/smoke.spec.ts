import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const app = resolve(__dirname, '..')
const repo = resolve(app, '..')
const scripts = join(repo, 'skills', 'knuaf-doc', 'scripts')
const python = process.env.KNUAF_PYTHON ?? join(repo, '.venv-dev', 'bin', 'python')

function synthProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'kd-e2e-'))
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'init', root], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
  mkdirSync(join(root, 'sections'), { recursive: true }); mkdirSync(join(root, 'sources'), { recursive: true })
  writeFileSync(join(root, 'sources', 'answers.md'), '# 원답변\n\n재배 면적: 600평\n', 'utf-8')
  writeFileSync(join(root, 'sections', '01.md'), '# Ⅰ. 머리말\n\n<!-- gg:draft:start -->\n농장A의 재배 면적은 600평이다.\n<!-- gg:draft:end -->\n', 'utf-8')
  const change = join(root, 'change.json')
  writeFileSync(change, JSON.stringify({ request_id: 'e2e:1', ops: [
    { collection: 'sources', value: { id: 'src-answers', path: 'sources/answers.md', claims: {} } },
    { collection: 'sections', value: { id: 'sec-01', title: 'Ⅰ. 머리말', order: 1, path: 'sections/01.md', status: 'drafting' } }
  ] }), 'utf-8')
  const a = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', '0'], { encoding: 'utf-8' })
  if (a.status !== 0) throw new Error(a.stdout + a.stderr)
  return root
}

test('open a project, see four lanes, export a draft, unlock a stale lock', async () => {
  const root = synthProject()
  const electronApp = await electron.launch({ args: [join(app, 'out', 'main', 'index.js')], env: { ...process.env, KNUAF_PYTHON: python, KNUAF_SCRIPTS_DIR: scripts } })
  const page = await electronApp.firstWindow()
  await page.waitForSelector('text=논문 작업 폴더')
  // the native folder picker cannot be driven, so paste the path
  await page.fill('input[aria-label="폴더 경로"]', root)
  await page.click('button:has-text("경로로 열기")')
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
  mkdirSync(join(root, '.gg-lock'))
  writeFileSync(join(root, '.gg-lock', 'owner.json'), JSON.stringify({ pid: 999999, host: require('node:os').hostname(), token: 'x' }))
  await page.click('nav >> text=문제 해결')
  await page.click('text=다시 진단')
  await expect(page.locator('text=남은 잠금')).toBeVisible({ timeout: 30_000 })
  await page.click('button:has-text("잠금 해제")')
  await page.click('dialog >> button:has-text("해제")')
  await expect(page.locator('text=잠금을 해제했습니다')).toBeVisible({ timeout: 30_000 })
  await electronApp.close()
})
