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
  /**
   * 창 크기를 **명시적으로** 되돌린다. 두 칸 배치(대화 | 내 논문)는 창 내부 폭이
   * `WIDE_MIN`(1140, shared/layout.ts) 이상일 때만 나오는데, 앱이 여는 1180 짜리 창은
   * 화면이 그보다 좁으면 OS 가 깎아 버린다 — GitHub 의 윈도우 러너 화면은 1024×768 이라
   * 1180 요청이 1024 로 줄고, 그러면 종이(`.paperpane`)를 보는 시험이 전부 '한 칸'을 본다.
   * 1180 은 앱의 기본값 그대로라 맥에서는 아무것도 바뀌지 않는다.
   */
  await electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setBounds({ width: 1180, height: 800 }) })
  if (opts.colorScheme || opts.reducedMotion) await page.emulateMedia({ colorScheme: opts.colorScheme, reducedMotion: opts.reducedMotion })
  // 첫 화면은 재실행에서 **두 단계 부품**(제목줄 아래)이 덮는다 — 연결이 확인돼 있으면 폴더
  // 단계, 끊겨 있으면 1단계(AI 연결). 둘 다에 있는 제목줄을 준비 신호로 기다린다.
  await page.waitForSelector(opts.waitFor ?? '.titlebar')
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
 * 작업공간 배치가 **멈출 때까지** 기다린다(맥 CI 처방).
 *
 * 폴더를 열면 대화가 먼저 뜨고 그 뒤에 종이 칸이 열리면서(절 목록을 읽은 뒤) **대화 칸 폭이
 * 좁아진다**(1,180 → 500 안팎). 그 재배치가 도는 동안 재거나 누르면 클릭이 빗나가고(버튼이
 * 그사이 움직인다) 좌표가 낡는다 — 맥 CI 에서 `chat-long`(펼치기 클릭이 안 먹음)·`qa2`(재는
 * 순간 노드가 붙지 않음) 가 그렇게 갈렸다. 두 rAF 연속 같은 모양이면 멈춘 것으로 본다.
 *
 * **한계(검토 MACR3-R1-02)**: 이 함수는 "지금 움직이지 않는다"만 본다. 아직 오지 않은 절 목록이
 * 나중에 배치를 바꾸지 않는다는 보장은 없다 — 로딩 중 빈 배치(solo·폭 1180)도 조용하다.
 * 그래서 부르는 쪽이 **자기가 쓸 요소의 준비**(`openProject` 의 `ready`)를 먼저 기다려야 한다.
 */
export async function settleWorkspace(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const ws = document.querySelector('.workspace')
    if (!ws) return false
    const chat = document.querySelector('.chat-pane') as HTMLElement | null
    const key = `${ws.className}|${Math.round(chat?.clientWidth ?? -1)}`
    const w = window as unknown as { __wsKey?: string; __wsSame?: number }
    if (w.__wsKey === key) w.__wsSame = (w.__wsSame ?? 0) + 1
    else { w.__wsKey = key; w.__wsSame = 0 }
    return (w.__wsSame ?? 0) >= 2
  }, undefined, { polling: 'raf', timeout: 15_000 })
}

/**
 * 이 폴더에 **본문이 있는 종이**가 자리 잡을 때까지 — 두 칸 배치(`.workspace.split`)가 된다.
 *
 * 본문이 있는 폴더를 여는 시험만 쓴다(`synthProject()` 는 본문이 있다). 본문 없는 폴더
 * (`synthProject({ withContent: false })`)에 쓰면 영원히 기다린다 — 그래서 기본값이 아니라
 * 호출자가 고른다(검토 MACR3-R1-02: 모든 폴더에 본문을 강제하지 않는다).
 */
export async function splitReady(page: Page): Promise<void> {
  await expect(page.locator('.workspace.split')).toBeVisible({ timeout: 30_000 })
}

/**
 * 종이 본문이 그려질 때까지(선택할 문단이 생길 때까지). `text` 를 주면 그 글자가 보일 때까지.
 * 종이에서 문단을 고르거나 종이 머리를 읽는 시험은 이 전제를 먼저 세운다.
 */
export async function paperReady(page: Page, text?: string): Promise<void> {
  const sheet = page.locator('.paperpane .sheet')
  await expect(sheet).toBeVisible({ timeout: 30_000 })
  if (text) await expect(sheet).toContainText(text, { timeout: 30_000 })
}

/**
 * Open a project by pasting its path (the native picker cannot be driven). The only path
 * input lives in 설정 > 고급 — the folder-less 내 논문 screen deliberately has none.
 *
 * v5 에서 설정은 **제목줄의 ⚙** 가 연다(왼쪽 사이드바가 없다). 폴더가 열리면 앱이 시트를
 * 닫고 작업 공간으로 돌아온다(store/project.ts open → closeSheet).
 *
 * `ready` 는 **호출자가 실제로 쓸 요소**(종이에서 고를 문단 = `paperReady`, 최종 두 칸 배치 =
 * `splitReady`)가 준비됐음을 확인하는 함수다. 배치 안정 확인은 그 **뒤에** 한다 — 그 전에
 * 보면 아직 오지 않은 절 목록이 배치를 바꾸는데도 "정착"으로 받아들인다(MACR3-R1-02).
 * 준비 조건을 주지 않으면 배치가 지금 조용한지만 본다.
 */
export async function openProject(page: Page, root: string, ready?: (p: Page) => Promise<unknown>): Promise<void> {
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
  // 호출자가 쓸 요소가 준비된 뒤에, 배치가 멈춘 것을 확인하고 돌려준다.
  if (ready) await ready(page)
  await settleWorkspace(page)
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
