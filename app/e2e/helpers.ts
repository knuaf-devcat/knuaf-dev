import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
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
  // e2e 창은 화면에 뜨지 않는다 — 맥에서 다른 작업을 가로채지 않게(main 의 KNUAF_E2E_HIDDEN).
  // 눈으로 봐야 할 때만 KNUAF_E2E_VISIBLE=1 로 끈다(window-shots.spec.ts 처럼 창을 찍는 spec).
  if (env.KNUAF_E2E_HIDDEN === undefined && env.KNUAF_E2E_VISIBLE !== '1') env.KNUAF_E2E_HIDDEN = '1'
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

/** 앱 화면이 준비됐다는 표시 — v5 에는 "내 논문" h1 이 없다(대화 칸 자체가 그 화면이다). */
export const CHAT_READY = '.chat-pane'

/**
 * 열려 있는 시트를 닫는다. v5 의 자료·결과물·설정은 오른쪽 시트, 제출 전 점검은 논문 칸을
 * 덮는 한 장이다 — 둘 다 Esc 로 닫힌다.
 */
export async function closeSheet(page: Page): Promise<void> {
  const over = page.locator('.sheetover')
  if (await over.count()) {
    // 논문 칸을 덮는 한 장은 닫기 단추가 확실한 길이다(Esc 도 되지만 겹친 창에서 흔들린다).
    await over.getByRole('button', { name: '닫기' }).first().click()
    await over.waitFor({ state: 'detached', timeout: 30_000 })
  }
  // 설정 시트 위에 확인 창이 겹쳐 있을 수 있다 — 열린 dialog 가 없어질 때까지 Esc 로 닫는다.
  for (let i = 0; i < 3 && (await page.locator('dialog[open]').count()); i++) {
    await page.locator('dialog[open]').last().press('Escape')
  }
}

/**
 * Open a project by pasting its path (the native picker cannot be driven). The only path
 * input lives in 설정 > 고급 — the folder-less 내 논문 screen deliberately has none.
 *
 * v5 에서 설정은 **제목줄의 ⚙** 가 연다(왼쪽 사이드바가 없다). 폴더가 열리면 앱이 시트를
 * 닫고 작업 공간으로 돌아온다(store/project.ts open → closeSheet).
 */
export async function openProject(page: Page, root: string): Promise<void> {
  await page.getByRole('button', { name: '설정' }).first().click()
  await page.waitForSelector('dialog[open]', { timeout: 30_000 })
  const disclosure = page.locator('details:has(input[aria-label="폴더 경로"])')
  await expect(disclosure).toHaveCount(1)
  await disclosure.first().evaluate((d) => { (d as HTMLDetailsElement).open = true })
  await page.fill('input[aria-label="폴더 경로"]', root)
  await page.click('button:has-text("경로로 열기")')
  // 열렸다 — 시트가 닫히고 대화 칸이 남는다.
  await page.waitForSelector(CHAT_READY, { timeout: 30_000 })
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 30_000 }).catch(() => {})
}

/**
 * v5 의 다섯 목적지로 간다. 이름은 v4 사이드바와 같게 두어 11개 spec 이 그대로 부르게 했다
 * (책임자 의견 ② — 한 곳에서 흡수한다):
 *   · '내 논문' — 시트를 닫는다(대화는 언제나 깔려 있다)
 *   · '설정' — 제목줄 ⚙
 *   · '자료' — 종이 머리 "자료 N" 팝오버 → 자료 전체 보기
 *   · '결과물' — 종이 머리 "파일 N" 팝오버 → 결과물 전체 보기
 *   · '점검' — 제목줄 "지금 ▾" → 전체 과정 → 제출 점검·마무리
 */
export async function navTo(page: Page, label: string): Promise<void> {
  await closeSheet(page)
  if (label === '내 논문') return
  if (label === '설정') {
    await page.getByRole('button', { name: '설정' }).first().click()
    return
  }
  if (label === '점검') {
    await page.locator('.titlebar .tbtn.now').click()
    await page.locator('.titlebar .popover').getByRole('button', { name: /제출 점검·마무리/ }).click()
    return
  }
  if (label === '자료' || label === '결과물') {
    const head = label === '자료' ? /자료/ : /파일/
    await page.locator('.paper-head').getByRole('button', { name: head }).first().click()
    await page.locator('.paper-head .popover').getByRole('button', { name: label === '자료' ? '자료 전체 보기' : '결과물 전체 보기' }).click()
    return
  }
  throw new Error(`모르는 목적지: ${label}`)
}



/** Open a 설정 disclosure by its deep-link preset (tools:export, fix:lock, folder:path…). */
export async function openPreset(page: Page, preset: string): Promise<void> {
  await page.locator(`details[data-preset="${preset}"]`).evaluate((d) => { (d as HTMLDetailsElement).open = true })
}


/** 절 하나를 등록하고 그 절에 본문을 써 넣는다 — "본문이 있는 장"이 하나 생긴다. */
export function addSectionBody(root: string, opts: { id?: string; title?: string; body?: string; expected?: number } = {}): void {
  const id = opts.id ?? 'sec-01'
  const title = opts.title ?? 'Ⅰ. 머리말'
  const body = opts.body ?? '농장A의 재배 면적은 600평이다.'
  mkdirSync(join(root, 'sections'), { recursive: true })
  writeFileSync(join(root, 'sections', `${id}.md`), `# ${title}\n\n<!-- gg:draft:start -->\n${body}\n<!-- gg:draft:end -->\n`, 'utf-8')
  const change = join(root, `change-${id}.json`)
  writeFileSync(change, JSON.stringify({ request_id: `e2e:p3:${id}`, ops: [
    { collection: 'sections', value: { id, title, order: 1, path: `sections/${id}.md`, status: 'drafting' } }
  ] }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(opts.expected ?? 0)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

/** 절 본문을 갈아 끼운다 — 기록이 오르고 "방금 저장된 문단"이 생긴다. */
export function rewriteSection(root: string, opts: { id?: string; body?: string; expected: number }): void {
  const id = opts.id ?? 'sec-01'
  writeFileSync(join(root, 'sections', `${id}.md`), `# Ⅰ. 머리말\n\n<!-- gg:draft:start -->\n${opts.body ?? ''}\n<!-- gg:draft:end -->\n`, 'utf-8')
  const change = join(root, `change-${id}-rewrite.json`)
  writeFileSync(change, JSON.stringify({ request_id: `e2e:p3:${id}:rw`, ops: [
    { collection: 'sections', value: { id, title: 'Ⅰ. 머리말', order: 1, path: `sections/${id}.md`, status: 'drafting' } }
  ] }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(opts.expected)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

/**
 * 장 하나를 `review_ready` 로 올린다 — "지금"이 3단계(검토본)가 되는 장면을 만든다.
 * 절 상태는 정본이 들고 있으므로 apply 로 올리고, 앱은 2초 감시로 따라온다.
 */
export function markSectionReady(root: string, opts: { id?: string; expected?: number } = {}): void {
  const id = opts.id ?? 'sec-01'
  const change = join(root, `change-${id}-ready.json`)
  writeFileSync(change, JSON.stringify({ request_id: `e2e:p3:${id}:ready`, ops: [
    { collection: 'sections', value: { id, title: 'Ⅰ. 머리말', order: 1, path: `sections/01.md`, status: 'review_ready' } }
  ] }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(opts.expected ?? 1)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

/** 창 크기를 실제로 바꾼다 — 폭 경계는 창 폭이라 `page.setViewportSize` 로는 안 바뀐다. */
export async function setWindowWidth(electronApp: ElectronApplication, width: number): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows()[0].setBounds({ width: w }) }, width)
}
