// 앱 안에서 Python 클릭 한 번 준비 — 네트워크 없이 전 경로(DESIGN §4.2).
//
// 실패는 **실제 PATH 실패**로 만든다: helper 의 기본 `KNUAF_PYTHON` 주입을 끄고(빈 값),
// PATH 맨 앞에 `python_too_old` 를 내는 가짜 `python3` 를 둔다(PY-D1-03). 내려받기는
// 로컬 HTTP 서버 + 가짜 tar.gz(실제 개발용 Python 을 exec)로 돌린다(fixtures/fake-runtime.ts).
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { launch, synthProject } from './helpers'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'
import { fakeRuntime, writeOldPython } from './fixtures/fake-runtime'

const FOLDER_STEP = 'text=논문을 담을 폴더를 골라요'
const FIX_BUTTON = 'Python 자동으로 준비하기'
/** 첫 실행 온보딩까지 켠 화면 — 1단계(AI 연결)가 아니라 2단계에서 시작한다(연결된 선택을 심는다). */
const WIN = process.platform === 'win32'

/** PATH 맨 앞에 낡은 `python3` 를 둔 환경 + 가짜 런타임 명세·서버 주소. */
function envWithOldPython(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  const base = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const pyBin = join(dir, 'pybin')
  writeOldPython(pyBin)
  // `KNUAF_PYTHON: ''` 로 helper 의 기본 주입을 끈다 — 그 값이 있으면 kind 가 env 가 되어
  // 준비 버튼의 대상이 아니다.
  // 번들이 있는 개발 기계에서도 "번들 없음 + PATH 3.9" 장면을 그대로 만든다.
  return { ...base, ...extra, KNUAF_PYTHON: '', KNUAF_NO_BUNDLE: '1', PATH: [pyBin, base.PATH].join(delimiter) }
}

function userDataWithRecent(dir: string, root: string): string {
  const userData = join(dir, 'userdata')
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({
    show_intro: false,
    recent: [{ root, opened_at: new Date().toISOString() }],
    provider_choice: { provider: 'codex', at: new Date().toISOString() }
  }), 'utf-8')
  return userData
}

function runtimeEntries(userData: string): string[] {
  const dir = join(userData, 'runtime')
  return existsSync(dir) ? readdirSync(dir) : []
}

test.skip(WIN, '가짜 python3 셸 스크립트는 POSIX 전용 — 윈도우는 형님 실기 확인')

test('낡은 PATH Python → 오류 카드의 버튼 → 진행률 → managed 로 열린다', async () => {
  const dir = scratch()
  const root = synthProject()
  const rt = await fakeRuntime()
  const userData = userDataWithRecent(dir, root)
  const { electronApp, page } = await launch({
    userData, onboarded: false, waitFor: FOLDER_STEP,
    env: envWithOldPython(dir, { KNUAF_RUNTIME_SPEC: rt.specPath, KNUAF_RUNTIME_BASE_URL: rt.baseUrl })
  })
  try {
    // ① 첫 실행(온보딩 미완료) 화면의 2단계에서 최근 폴더를 연다 → 시작 단계에서 실패한다.
    await page.locator('.project').first().click()
    await expect(page.getByText('Python 버전이 너무 낮아요')).toBeVisible({ timeout: 30_000 })
    // 실패한 그 선택(path)을 근거로 준비 버튼이 선다 — 이전 프로젝트의 kind 로 판단하지 않는다.
    const fix = page.getByRole('button', { name: FIX_BUTTON })
    await expect(fix).toBeVisible()

    // ② 버튼 → 진행률 → 설치가 끝나면 실패했던 폴더 열기를 다시 시도한다.
    await fix.click()
    await expect(page.locator('.progress')).toBeVisible({ timeout: 15_000 })
    await page.waitForSelector('.chat-inner', { timeout: 60_000 })

    // ③ 사이드카는 관리 런타임으로 실행 중이고, 설치 폴더에는 도장이 있다.
    const info = await page.evaluate(() => window.knuaf.sidecarInfo())
    expect(info.kind).toBe('managed')
    expect(info.running).toBe(true)
    const installs = runtimeEntries(userData).filter((n) => n.startsWith('cpython-'))
    expect(installs).toHaveLength(1)
    expect(existsSync(join(userData, 'runtime', installs[0], '.knuaf-runtime.json'))).toBe(true)
    // 온보딩도 마저 지나갔다 — 재시도가 기존 성공 후처리를 그대로 탔다.
    const settings = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf-8')) as { onboarded_at?: string }
    expect(settings.onboarded_at).toBeTruthy()
    // 임시 다운로드 파일은 남지 않는다.
    expect(runtimeEntries(userData).filter((n) => n.startsWith('.download-'))).toEqual([])
  } finally {
    await electronApp.close()
    await rt.close()
  }
})

test('해시가 다르면 설치하지 않고, 설치 폴더·임시 파일을 남기지 않는다', async () => {
  const dir = scratch()
  const root = synthProject()
  const rt = await fakeRuntime({ hash: '0'.repeat(64) })
  const userData = userDataWithRecent(dir, root)
  const { electronApp, page } = await launch({
    userData, waitFor: FOLDER_STEP,
    env: envWithOldPython(dir, { KNUAF_RUNTIME_SPEC: rt.specPath, KNUAF_RUNTIME_BASE_URL: rt.baseUrl })
  })
  try {
    await page.locator('.project').first().click()
    await page.getByRole('button', { name: FIX_BUTTON }).click()
    await expect(page.getByText('받은 파일이 예상과 달라 설치하지 않았어요')).toBeVisible({ timeout: 30_000 })
    expect(runtimeEntries(userData).filter((n) => n.startsWith('cpython-'))).toEqual([])
    expect(runtimeEntries(userData).filter((n) => n.startsWith('.download-'))).toEqual([])
    // 여전히 열리지 않았다 — 설치 실패를 복구 성공으로 표시하지 않는다(재시도 자체를 부르지 않았다).
    await expect(page.getByText('Python은 준비됐지만 이 폴더는 아직 열리지 않았어요')).toHaveCount(0)
    await expect(page.getByText('앱 전용 Python을 준비했어요')).toHaveCount(0)
    await expect(page.locator(FOLDER_STEP)).toBeVisible()
  } finally {
    await electronApp.close()
    await rt.close()
  }
})

test('직접 지정한 실행기(env)가 원인이면 준비 버튼을 세우지 않는다', async () => {
  const dir = scratch()
  const root = synthProject()
  const rt = await fakeRuntime()
  const userData = userDataWithRecent(dir, root)
  const old = join(dir, 'pybin', 'python3')
  writeOldPython(join(dir, 'pybin'))
  const { electronApp, page } = await launch({
    userData, waitFor: FOLDER_STEP,
    env: {
      ...fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' }),
      KNUAF_PYTHON: old,
      KNUAF_NO_BUNDLE: '1',
      KNUAF_RUNTIME_SPEC: rt.specPath,
      KNUAF_RUNTIME_BASE_URL: rt.baseUrl
    }
  })
  try {
    await page.locator('.project').first().click()
    await expect(page.getByText('Python 버전이 너무 낮아요')).toBeVisible({ timeout: 30_000 })
    // 사용자가 고른 경로를 몰래 무시하지 않는다 — 기존 안내만 남는다.
    await expect(page.getByRole('button', { name: FIX_BUTTON })).toHaveCount(0)
  } finally {
    await electronApp.close()
    await rt.close()
  }
})
