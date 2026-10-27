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
 *
 * 두 실행의 크기는 ±1px 까지 같은 것으로 본다(JITTER_PX). 맥 CI 에서 코드와 무관하게 1px 로
 * 떨어졌다 — 첫 실행 창 높이 634, 둘째 635, 너비는 984 로 같았다(PR #14 run 40475333811).
 * 흔들림만 흡수하고, 앱이 크기를 바꾸는 회귀(20px 대)는 그대로 잡는다.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { synthProject } from './helpers'
import { fakeCodexEnv, scratch, writeFakeClaude } from './fixtures/fake-codex'

const app = resolve(__dirname, '..')
const repo = resolve(app, '..')
const scripts = join(repo, 'skills', 'knuaf-dev', 'scripts')
const python = process.env.KNUAF_PYTHON ?? join(repo, '.venv-dev', 'bin', 'python')

/** 앱을 숨김 실행으로 띄운다 — helpers.launch() 와 달리 창 크기를 손대지 않는다. */
async function openApp(userData: string, extraEnv: Record<string, string> = {}): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KNUAF_PYTHON: python, KNUAF_SCRIPTS_DIR: scripts, KNUAF_USER_DATA: userData, KNUAF_E2E_HIDDEN: '1',
    ...extraEnv
  }
  delete env.ELECTRON_RUN_AS_NODE
  const electronApp = await electron.launch({ args: [join(app, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`], env })
  const page = await electronApp.firstWindow()
  // 첫 화면의 정체(폴더 화면)에 기대지 않는다 — 온보딩을 지난 재실행에 늘 있는 제목줄을 기다린다.
  await page.waitForSelector('.titlebar', { timeout: 30_000 })
  return { electronApp, page }
}

type Size = { w: number; h: number }
type Measure = { bounds: Size; content: Size; inner: Size; workArea: Size }

/** 창 크기를 세 곳에서 동시에 잰다 — 바깥·안쪽·렌더러. 작업 영역도 함께 남긴다(실패 이유 진단용). */
async function measureWindow(ea: ElectronApplication, page: Page): Promise<Measure> {
  const main = await ea.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const { width, height } = screen.getPrimaryDisplay().workAreaSize
    return { bounds: w.getBounds(), content: w.getContentBounds(), workArea: { w: width, h: height } }
  })
  const renderer = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const size = (s: { width: number; height: number }): Size => ({ w: s.width, h: s.height })
  return { bounds: size(main.bounds), content: size(main.content), inner: renderer, workArea: main.workArea }
}

/**
 * 재실행 사이의 1px 차이는 러너가 보고한 작업 영역이 다르게 잡힌 탓이다 — 앱은 크기를 작업
 * 영역에서 계산하므로(`shared/window.ts`) 같은 화면이면 같은 값이 나온다. 그 흔들림만 흡수한다.
 */
const JITTER_PX = 1

/** 같은 자리에서 잰 두 크기를 ±1px 로 비교한다. 그보다 크면 앱이 크기를 바꾼 것이다. */
function expectSameSize(before: Size, now: Size, what: string, areas: { before: Size; now: Size }): void {
  const where = `작업 영역 ${areas.before.w}×${areas.before.h} → ${areas.now.w}×${areas.now.h}`
  expect(Math.abs(now.w - before.w), `${what} 너비가 재실행에서 ${before.w} → ${now.w} 로 달라졌다 (${where})`).toBeLessThanOrEqual(JITTER_PX)
  expect(Math.abs(now.h - before.h), `${what} 높이가 재실행에서 ${before.h} → ${now.h} 로 달라졌다 (${where})`).toBeLessThanOrEqual(JITTER_PX)
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
  // 저장된 선택(codex)+codex 만 연결이면 1단계(AI 연결)가 서고, 둘 다 연결이면 폴더 단계다
  // (W2 D2). 이 시험이 보는 것은 창 크기뿐이지만, 전제는 "이미 지난 학생"으로 맞춰 둔다.
  const bin = join(scratch(), 'bin')
  writeFakeClaude(bin)
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in' })

  const first = await openApp(userData, env)
  const a = await measureWindow(first.electronApp, first.page)
  await first.electronApp.close()

  const second = await openApp(userData, env)
  const b = await measureWindow(second.electronApp, second.page)
  await second.electronApp.close()

  // 두 실행의 크기가 같다 — 창 크기를 바꾸는 것은 앱이 아니라 밖(사용자·OS)이라는 뜻이다.
  const areas = { before: a.workArea, now: b.workArea }
  expectSameSize(a.bounds, b.bounds, '창 바깥', areas)
  expectSameSize(a.content, b.content, '창 안쪽', areas)
  expectSameSize(a.inner, b.inner, '렌더러 안쪽', areas)
})
