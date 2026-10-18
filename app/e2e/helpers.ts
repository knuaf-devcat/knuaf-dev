import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export const app = resolve(__dirname, '..')
export const repo = resolve(app, '..')
export const scripts = join(repo, 'skills', 'knuaf-dev', 'scripts')
export const python = process.env.KNUAF_PYTHON ?? join(repo, '.venv-dev', 'bin', 'python')

/** init-only project (revision 0) or a project with a source, a section and a fact (revision 1). */
export function synthProject(opts: { withContent?: boolean } = { withContent: true }): string {
  const root = mkdtempSync(join(tmpdir(), 'kd-e2e-'))
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'init', root], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
  if (!opts.withContent) return root
  mkdirSync(join(root, 'sections'), { recursive: true }); mkdirSync(join(root, 'sources'), { recursive: true })
  writeFileSync(join(root, 'sources', 'answers.md'), '# 원답변\n\n재배 면적: 600평\n', 'utf-8')
  writeFileSync(join(root, 'sections', '01.md'), '# Ⅰ. 머리말\n\n<!-- gg:draft:start -->\n농장A의 재배 면적은 600평이다. 정읍 일대 기후를 고려해 작목을 선택했다.\n<!-- gg:draft:end -->\n', 'utf-8')
  const change = join(root, 'change.json')
  writeFileSync(change, JSON.stringify({ request_id: 'e2e:1', ops: [
    { collection: 'sources', value: { id: 'src-answers', path: 'sources/answers.md', claims: {} } },
    { collection: 'sections', value: { id: 'sec-01', title: 'Ⅰ. 머리말', order: 1, path: 'sections/01.md', status: 'drafting' } },
    { collection: 'facts', value: { id: 'fact-area', field_id: 'farm.area', kind: 'reported_fact', value: '600', unit: '평', value_type: 'decimal', period: '2026', scope: '농장A', answer_state: 'provided', verification: 'unreviewed', source_refs: [{ id: 'src-answers', revision: 1, locator: 'L3' }] } }
  ] }), 'utf-8')
  const a = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', '0'], { encoding: 'utf-8' })
  if (a.status !== 0) throw new Error(a.stdout + a.stderr)
  return root
}

export function plantStaleLock(root: string): void {
  mkdirSync(join(root, '.gg-lock'))
  writeFileSync(join(root, '.gg-lock', 'owner.json'), JSON.stringify({ pid: 999999, host: require('node:os').hostname(), token: 'x', acquired_at: Date.now() / 1000 - 3600 }))
}

export async function launch(opts: { userData?: string; colorScheme?: 'light' | 'dark'; reducedMotion?: 'reduce' | 'no-preference'; env?: Record<string, string>; intro?: boolean; onboarded?: boolean; waitFor?: string } = {}): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'kd-userdata-'))
  /**
   * 여는 화면은 켤 때마다 화면을 덮고 2.6초를 쓴다. 대부분의 테스트는 그것을 보려는 게
   * 아니라 그 뒤의 화면을 보려는 것이므로 기본적으로 꺼 둔다(`intro: true` 면 켠다).
   *
   * `onboarded_at` 도 같이 적는다. 첫 실행 화면(AI 연결 → 논문 폴더)이 생기면서, 이 표시가
   * 없는 폴더에서는 앱이 온보딩을 띄운다 — 그러면 기존 스펙 28개가 전부 폴더 화면 대신
   * 온보딩을 보게 된다. 첫 실행 자체를 보는 스펙은 `onboarded: false` 로 끈다.
   *
   * 스펙이 직접 써 둔 settings.json 은 **덮지 않고 이어 쓴다** — 그 안의 값(옛 helper_mode 등)이
   * 시험 대상이기 때문이다.
   */
  const settingsFile = join(userData, 'settings.json')
  mkdirSync(userData, { recursive: true })
  let preset: Record<string, unknown> = {}
  if (existsSync(settingsFile)) {
    try { preset = JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown> } catch { preset = {} }
  }
  if (!opts.intro && preset.show_intro === undefined) preset.show_intro = false
  if (opts.onboarded === false) delete preset.onboarded_at
  else if (!preset.onboarded_at) preset.onboarded_at = new Date().toISOString()
  writeFileSync(settingsFile, JSON.stringify(preset), 'utf-8')
  // A shell that exports ELECTRON_RUN_AS_NODE would make the app run as plain Node (require('electron') yields the binary path).
  const env = { ...process.env, KNUAF_PYTHON: python, KNUAF_SCRIPTS_DIR: scripts, KNUAF_USER_DATA: userData, ...opts.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electronApp = await electron.launch({
    args: [join(app, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
    env,
    colorScheme: opts.colorScheme
  })
  const page = await electronApp.firstWindow()
  if (opts.colorScheme || opts.reducedMotion) await page.emulateMedia({ colorScheme: opts.colorScheme, reducedMotion: opts.reducedMotion })
  await page.waitForSelector(opts.waitFor ?? 'text=논문 작업 폴더')
  return { electronApp, page }
}

/**
 * Open a project by pasting its path (the native picker cannot be driven). The only path
 * input lives in 설정 > 고급 — the folder-less 내 논문 screen deliberately has none.
 */
export async function openProject(page: Page, root: string): Promise<void> {
  await navTo(page, '설정')
  const disclosure = page.locator('details:has(input[aria-label="폴더 경로"])')
  if (await disclosure.count()) await disclosure.first().evaluate((d) => { (d as HTMLDetailsElement).open = true })
  await page.fill('input[aria-label="폴더 경로"]', root)
  await page.click('button:has-text("경로로 열기")')
}

/** Click one of the five primary sidebar destinations by label. */
export async function navTo(page: Page, label: string): Promise<void> {
  await page.locator('nav').getByRole('button', { name: label, exact: true }).click()
}

/** Open a 설정 disclosure by its deep-link preset (tools:export, fix:lock, folder:path…). */
export async function openPreset(page: Page, preset: string): Promise<void> {
  await page.locator(`details[data-preset="${preset}"]`).evaluate((d) => { (d as HTMLDetailsElement).open = true })
}
