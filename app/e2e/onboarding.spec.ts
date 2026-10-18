// 첫 실행 화면(단계 2) — 실제 Electron 을 띄운다.
//
// 여기 있는 것: 설정 키의 기본값·이행 규칙, 그리고 "연결 도구가 없다"는 관찰 상태.
// 여기 없는 것(단계 1 합류 뒤에 채운다 — 발주 ③ 파일 소유 경계, 가짜 codex 서버 픽스처가
// 단계 1 워커의 `e2e/fixtures/fake-codex-server.mjs` 이다):
//   · 가짜 서버로 로그인 → 연결됨 → 2단계 → 새 폴더 → 대화에 "시작하기" 1개
//   · 설정 없음 + 둘 다 연결됨 → 선택 화면(건너뛰지 않음)
//   · provider_choice=claude + Claude 연결됨 → 1단계 건너뜀
//   · 최근 논문으로 들어갈 때 온보딩을 거치지 않음(NoFolder 흡수와 함께)
import { expect, test } from '@playwright/test'
import { readFileSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { launch } from './helpers'

const INTRO = 'text=먼저, 쓰고 있는 AI를 연결해요'
const settings = (userData: string) => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf-8'))
// 확인용 캡처는 저장소 밖 설계 폴더에 남긴다 — `docs/images/` 는 학생 안내서 사진이라
// 스크린샷 spec 이 실행할 때마다 덮어쓴다(책임자 지시). 실기기 캡처(window-shots.spec.ts)는
// macOS 화면 기록 권한과 "우리 앱이 맨 앞"을 요구해 회색으로 실패하기도 한다 — 이 화면은
// 웹 층만 보면 되므로 page.screenshot 으로 남긴다.
const SHOTS = process.env.KNUAF_SHOTS_DIR ?? resolve('/Users/nara/knuaf-dev/docs/design/gui-2026-10-opus-v5/impl/shots-p2')
const noTool = () => {
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
  return { userData, env: { KNUAF_AGENT_PATH_ONLY: '1', PATH: '', HOME: home } }
}

test('설정 파일이 없으면 provider_choice 는 null 이고 helper_mode 는 기본값이다', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const { electronApp, page } = await launch({ userData, onboarded: false, waitFor: INTRO })
  const s = await page.evaluate(() => window.knuaf.getSettings())
  expect(s.provider_choice, '고른 적이 없는데 선택이 있다').toBeNull()
  expect(s.helper_mode, '기본값은 지금처럼 codex-chat').toBe('codex-chat')
  await electronApp.close()
})

test('옛 설정(helper_mode 만)을 선택으로 승격하지 않는다', async () => {
  // IMPL-R1-02. helper_mode 는 고른 적이 없어도 기본값이 채워져 저장된다 —
  // 그 값을 선택으로 읽으면 첫 실행 화면을 영영 건너뛴다.
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ show_intro: false, recent: [], helper_mode: 'claude-chat' }), 'utf-8')
  const { electronApp, page } = await launch({ userData, onboarded: false, waitFor: INTRO })
  const s = await page.evaluate(() => window.knuaf.getSettings())
  expect(s.helper_mode).toBe('claude-chat')
  expect(s.provider_choice, '옛 helper_mode 를 선택으로 승격했다').toBeNull()
  await electronApp.close()
})

test('온보딩을 마치기 전에는 onboarded_at 이 없다 — 화면이 매번 첫 실행으로 돌아간다', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const { electronApp, page } = await launch({ userData, onboarded: false, waitFor: INTRO })
  const s = await page.evaluate(() => window.knuaf.getSettings())
  expect(s.onboarded_at).toBeNull()
  // 아직 연결이 없으므로 폴더 단계로 넘어갈 수 없다 — 연결 하나가 첫 화면의 조건이다.
  await expect(page.getByRole('button', { name: '다음 — 논문 폴더 고르기' })).toBeDisabled()
  await electronApp.close()
})

test('PATH 로 도구를 찾을 수 없으면 그렇게 말하고 다시 확인을 제공한다', async () => {
  // KNUAF_AGENT_PATH_ONLY=1 + 빈 PATH + 빈 HOME: 개발 기계에 진짜 codex·claude 가 깔려
  // 있어도 "도구 없음" 상태를 재현한다. 실제 설치 도구는 건드리지 않는다.
  const { userData, env } = noTool()
  const { electronApp, page } = await launch({ userData, onboarded: false, waitFor: INTRO, env })
  // 도구가 없다는 사실을 상태로 말한다 — 로그인을 시키지 않는다.
  await expect(page.locator('text=연결 도구(Codex)를 먼저 설치해요')).toBeVisible()
  await expect(page.locator('text=연결 도구(Claude Code)를 먼저 설치해요')).toBeVisible()
  // 설치 안내와 다시 확인이 같은 줄에 있다.
  await expect(page.getByRole('button', { name: '설치 안내' }).first()).toBeVisible()
  const recheck = page.getByRole('button', { name: '다시 확인' }).first()
  await expect(recheck).toBeVisible()
  // 다시 확인은 같은 사실을 다시 말한다 — 확인 실패로 꾸미지 않는다.
  await recheck.click()
  await expect(page.locator('text=연결 도구(Codex)를 먼저 설치해요')).toBeVisible()
  // 설정에는 아무것도 선택되지 않았다.
  expect(settings(userData).provider_choice).toBeUndefined()
  await electronApp.close()
})

/**
 * 화면 캡처. 지금 찍을 수 있는 것은 "도구 없음" 상태 하나다 — 연결됨·로그인 중·2단계는
 * 가짜 codex 서버(단계 1 소유 픽스처)가 있어야 만들 수 있어 합류 뒤에 찍는다.
 * 저장 위치가 없는 기계(CI 등)에서는 건너뛴다 — 저장소 안에 쓰지 않는다.
 */
test.skip(!existsSync(dirname(SHOTS)), 'capture destination is outside this checkout')
for (const scheme of ['light', 'dark'] as const) {
  test(`첫 실행 화면 캡처 (${scheme}) — 도구 없음`, async () => {
    const { userData, env } = noTool()
    const { electronApp, page } = await launch({ userData, onboarded: false, colorScheme: scheme, waitFor: INTRO, env })
    await page.setViewportSize({ width: 1180, height: 800 })
    mkdirSync(SHOTS, { recursive: true })
    const file = join(SHOTS, `step1-no-tool-${scheme}.png`)
    await page.screenshot({ path: file })
    console.log('captured', file, statSync(file).size, 'bytes')
    await electronApp.close()
  })
}
