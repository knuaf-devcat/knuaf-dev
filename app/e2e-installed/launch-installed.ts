// 설치본(dmg → /Applications)을 **실제로 띄우는** 진입점.
//
// 왜 `e2e/helpers.ts` 의 `launch()` 를 쓰지 않는가: 그 함수는 개발 트리(`out/main/index.js`)를
// 띄우고 `KNUAF_PYTHON`·`KNUAF_SCRIPTS_DIR` 을 **저장소 경로로 덮어쓴다**. 설치본 시험의 대상이
// 바로 "저장소가 아니라 번들 안의 python·스킬로 도는가"이므로 그 두 값을 덮으면 시험이 사라진다.
// 그래서 이 파일은 그 변수들을 **지우고** 띄운다 — 설치본의 자동 선택 경로(`bundled`)를 그대로 탄다.
//
// 실행: KNUAF_INSTALLED_APP="/Applications/KNUAF-Dev · 창업논문 작성 도우미.app" \
//         pnpm exec playwright test --config playwright.installed.config.ts
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 설치된 `.app` 번들 경로 — 워크플로가 넘긴다. 없으면 이 시험들은 의미가 없으므로 바로 실패한다. */
export const INSTALLED_APP_ENV = 'KNUAF_INSTALLED_APP'

/**
 * 개발 트리에서만 뜻이 있는 변수들. 설치본 시험이 이것들을 물려받으면 "번들로 도는가"를
 * 시험하는 대신 저장소 경로를 쓰면서 통과해 버린다(가짜 초록). 띄우기 전에 전부 지운다.
 */
const DEV_ONLY_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'KNUAF_PYTHON',
  'KNUAF_SCRIPTS_DIR',
  'KNUAF_USER_DATA',
  'KNUAF_NO_BUNDLE',
  'KNUAF_RUNTIME_SPEC',
  'KNUAF_RUNTIME_BASE_URL',
  'KNUAF_AGENT_PATH_ONLY',
  'KNUAF_SHOTS_DIR',
  'KNUAF_SHOT_DIR',
  'KNUAF_LIVE'
]

export function installedApp(): string {
  const p = process.env[INSTALLED_APP_ENV]
  if (!p) throw new Error(`${INSTALLED_APP_ENV} 가 없다 — 이 시험은 설치된 .app 을 띄운다(.github/workflows/installer-e2e.yml)`)
  if (!existsSync(p)) throw new Error(`${INSTALLED_APP_ENV} 경로가 없다: ${p}`)
  return p
}

/**
 * 번들 안 실행파일 이름은 Info.plist 가 정본이다 — 한글·공백·가운뎃점이 들어 있어
 * `electron-builder.yml` 의 `executableName` 을 코드에 다시 적으면 두 곳이 갈린다.
 */
function bundleExecutable(app: string): string {
  const name = execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')], { encoding: 'utf-8' }).trim()
  if (!name) throw new Error(`CFBundleExecutable 이 비었다: ${app}`)
  return name
}

/** 설치본에서 앱이 실제로 읽는 자리들(`python.ts`·`runtime.ts` 의 packaged 분기와 같은 경로). */
export function bundle(app: string = installedApp()): {
  app: string; resources: string; executable: string; python: string; scripts: string; sidecar: string; wheelhouse: string; docs: string
} {
  const resources = join(app, 'Contents', 'Resources')
  return {
    app,
    resources,
    executable: join(app, 'Contents', 'MacOS', bundleExecutable(app)),
    python: join(resources, 'python', 'bin', 'python3'),
    scripts: join(resources, 'skill', 'scripts'),
    sidecar: join(resources, 'sidecar'),
    wheelhouse: join(resources, 'wheelhouse'),
    docs: join(resources, 'docs')
  }
}

/**
 * 설치본을 띄운다.
 *
 * - `userData: '<경로>'` — 그 폴더를 쓴다(첫 실행 상태를 매번 새로 만드는 기본값은 임시 폴더).
 * - `userData: null` — **아무것도 넘기지 않는다**. 앱이 스스로 고른 자리
 *   (`~/Library/Application Support/knuaf-dev`)를 그대로 쓰는 유일한 장면이다 — 학생의 첫 실행과 같다.
 */
export async function launchInstalled(
  opts: { userData?: string | null; env?: Record<string, string>; waitFor?: string } = {}
): Promise<{ electronApp: ElectronApplication; page: Page; userData: string | null }> {
  const b = bundle()
  const userData = opts.userData === null ? null : opts.userData ?? mkdtempSync(join(tmpdir(), 'kd-installed-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of DEV_ONLY_ENV) delete env[k]
  Object.assign(env, opts.env)
  // 창을 화면에 띄우지 않는다 — 러너의 다른 창을 가로채지 않게(main 의 KNUAF_E2E_HIDDEN).
  if (env.KNUAF_E2E_VISIBLE !== '1') env.KNUAF_E2E_HIDDEN = '1'
  // `--inspect=0` 은 Playwright 가 붙는다(설치본도 Electron 기본 퓨즈라 CLI inspect 가 살아 있다).
  const electronApp = await electron.launch({
    executablePath: b.executable,
    args: userData ? [`--user-data-dir=${userData}`] : [],
    env,
    colorScheme: 'light'
  })
  const page = await electronApp.firstWindow()
  // 러너 화면(1024×768)이 창을 깎으면 두 칸 배치(폭 ≥ 1140)가 안 나온다 — 개발 빌드 e2e 와 같은 처방.
  await electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setBounds({ width: 1180, height: 800 }) })
  await page.waitForSelector(opts.waitFor ?? '.titlebar', { timeout: 60_000 })
  return { electronApp, page, userData }
}

/**
 * 첫 실행 화면을 **건너뛰는** userData. `e2e/helpers.ts` 의 `launch()` 와 같은 두 키를 심는다 —
 * 여는 화면(2.6초)과 온보딩을 끄는 값이다. 첫 실행 자체를 보는 시험은 이 함수를 쓰지 않는다.
 */
export function seededUserData(dir: string = mkdtempSync(join(tmpdir(), 'kd-installed-ud-'))): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ show_intro: false, onboarded_at: new Date().toISOString() }), 'utf-8')
  return dir
}

/**
 * 시험용 작업 폴더 하나 — **동봉 python 과 동봉 스킬로** 만든다. 저장소의 `.venv-dev` 나
 * `skills/` 를 쓰지 않는 것이 요점이다: 설치본이 자기 번들만으로 폴더를 다룰 수 있는지가
 * 이 트랙의 시험 대상이다.
 */
export function bundledProject(opts: { withContent?: boolean } = { withContent: true }): string {
  const b = bundle()
  const run = (args: string[]) => {
    const r = execFileSync(b.python, args, { encoding: 'utf-8' })
    return r
  }
  const root = mkdtempSync(join(tmpdir(), 'kd-installed-project-'))
  run([join(b.scripts, 'gg.py'), 'init', root])
  if (!opts.withContent) return root
  mkdirSync(join(root, 'sections'), { recursive: true })
  mkdirSync(join(root, 'sources'), { recursive: true })
  writeFileSync(join(root, 'sources', 'answers.md'), '# 원답변\n\n재배 면적: 600평\n', 'utf-8')
  writeFileSync(join(root, 'sections', '01.md'), '# Ⅰ. 머리말\n\n<!-- gg:draft:start -->\n농장A의 재배 면적은 600평이다. 정읍 일대 기후를 고려해 작목을 선택했다.\n<!-- gg:draft:end -->\n', 'utf-8')
  const change = join(root, 'change.json')
  writeFileSync(change, JSON.stringify({ request_id: 'installed:1', ops: [
    { collection: 'sources', value: { id: 'src-answers', path: 'sources/answers.md', claims: {} } },
    { collection: 'sections', value: { id: 'sec-01', title: 'Ⅰ. 머리말', order: 1, path: 'sections/01.md', status: 'drafting' } },
    { collection: 'facts', value: { id: 'fact-area', field_id: 'farm.area', kind: 'reported_fact', value: '600', unit: '평', value_type: 'decimal', period: '2026', scope: '농장A', answer_state: 'provided', verification: 'unreviewed', source_refs: [{ id: 'src-answers', revision: 1, locator: 'L3' }] } }
  ] }), 'utf-8')
  run([join(b.scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', '0'])
  return root
}
