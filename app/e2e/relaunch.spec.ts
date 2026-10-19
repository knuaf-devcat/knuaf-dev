/**
 * 재실행(두 번째 실행) 창 크기 — ORDER-RELAUNCH / REPORT-RELAUNCH.
 *
 * 형님이 "AI 로그인하고 폴더를 등록한 뒤 껐다 켠 상태"의 첫 화면 비율이 이상하다고 봤다.
 * 관제 실측은 초기화 뒤 첫 실행 1180×800, 상태가 남은 채 다시 켠 창 1204×779 였다.
 * 그래서 같은 userData 로 두 번 켜는 길을 여기서 잰다 — 그 길을 보는 시험이 없었다.
 *
 * 잠그는 것은 **하나뿐**이다: 창 크기가 재실행으로 달라지지 않는다(앱이 창 크기·위치를
 * 저장·복원하는 코드가 없다). 절대값(1180×800)은 단언하지 않는다 — 기본 창 크기를
 * 1280×800(작업 영역에 맞춰 줄임)으로 바꾸는 일과, 첫 화면을 시안 ② 논문 폴더 화면으로
 * 맞추는 일 및 그 시험은 QA 워커(`knuaf-dev-wt/qa`)가 맡는다(책임자 2026-10-19 갱신).
 *
 * helpers.launch() 를 쓰지 않는다. 그 함수는 창을 띄운 뒤 `setBounds({1180,800})` 로 크기를
 * 되돌리는데, 그러면 "재실행이 창 크기를 바꾸는가"라는 이 발주의 질문 자체가 가려진다.
 * 여기서는 앱이 스스로 만든 창을 그대로 잰다(main/index.ts:71~75).
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { synthProject } from './helpers'

const app = resolve(__dirname, '..')
const repo = resolve(app, '..')
const scripts = join(repo, 'skills', 'knuaf-dev', 'scripts')
const python = process.env.KNUAF_PYTHON ?? join(repo, '.venv-dev', 'bin', 'python')

/** 앱을 숨김 실행으로 띄운다 — helpers.launch() 와 달리 창 크기를 손대지 않는다. */
async function openApp(userData: string): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KNUAF_PYTHON: python, KNUAF_SCRIPTS_DIR: scripts, KNUAF_USER_DATA: userData, KNUAF_E2E_HIDDEN: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  const electronApp = await electron.launch({ args: [join(app, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`], env })
  const page = await electronApp.firstWindow()
  // 첫 화면의 정체(폴더 화면)에 기대지 않는다 — 온보딩을 지난 재실행에 늘 있는 제목줄을 기다린다.
  await page.waitForSelector('.titlebar', { timeout: 30_000 })
  return { electronApp, page }
}

/** 창 크기를 세 곳에서 동시에 잰다 — 바깥·안쪽·렌더러. */
async function measureWindow(ea: ElectronApplication, page: Page) {
  const main = await ea.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    return { bounds: w.getBounds(), content: w.getContentBounds() }
  })
  const renderer = await page.evaluate(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }))
  return { ...main, ...renderer }
}

/** 재실행 상태를 심은 userData — 온보딩을 지난 학생 + 최근 목록. */
function seeded(userData: string, recentRoots: string[]): string {
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({
    show_intro: false,
    onboarded_at: '2026-10-18T00:00:00.000Z',
    provider_choice: { provider: 'codex', at: '2026-10-18T00:00:00.000Z' },
    recent: recentRoots.map((root) => ({ root, opened_at: '2026-10-18T00:00:00.000Z' }))
  }), 'utf-8')
  return userData
}

test('같은 userData 로 두 번 켜도 창 크기가 같다 — 앱은 창 크기를 저장·복원하지 않는다', async () => {
  // 본문이 있는 논문을 등록해 둔 상태 — 형님이 본 조건(로그인 + 폴더 등록 뒤 재실행)에서
  // 가장 "열릴 만한" 상태다. 그래도 저절로 열리지 않고 창 크기도 달라지지 않는다.
  const userData = seeded(join(mkdtempSync(join(tmpdir(), 'kd-relaunch-')), 'userdata'), [synthProject()])

  const first = await openApp(userData)
  const a = await measureWindow(first.electronApp, first.page)
  await first.electronApp.close()

  const second = await openApp(userData)
  const b = await measureWindow(second.electronApp, second.page)
  await second.electronApp.close()

  // 두 실행의 크기가 같다 — 창 크기를 바꾸는 것은 앱이 아니라 밖(사용자·OS)이라는 뜻이다.
  expect({ w: b.bounds.width, h: b.bounds.height }, '재실행에서 창 크기가 달라졌다').toEqual({ w: a.bounds.width, h: a.bounds.height })
  expect({ w: b.content.width, h: b.content.height }).toEqual({ w: a.content.width, h: a.content.height })
  expect({ w: b.innerWidth, h: b.innerHeight }).toEqual({ w: a.innerWidth, h: a.innerHeight })
})
