// 첫 실행 화면 — 실제 Electron 을 띄운다.
//
// 여기 있는 것: 설정 키의 기본값·이행 규칙, "연결 도구가 없다"는 관찰 상태, 그리고 가짜
// `codex app-server`(fixtures/fake-codex-server.mjs)·가짜 `claude` 로 만든 연결 장면들.
// 폴더를 여는 길은 **최근 목록**을 쓴다 — 네이티브 폴더 선택 창은 시험에서 몰 수 없다
// (helpers.ts 의 openProject 도 같은 이유로 설정의 경로 입력칸을 쓴다).
// 2단계의 "새 폴더 만들기"도 같은 코드 경로(open)를 타므로, 사람 손이 필요한 것은
// 대화상자를 여는 동작 하나뿐이다.
import { expect, test, type Page } from '@playwright/test'
import { readFileSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import { ONBOARD } from '../src/renderer/src/copy'
import { fakeCodexEnv, replyFile, scratch, writeCliShim, writeFakeClaude, writeStatefulClaude } from './fixtures/fake-codex'

const INTRO = 'text=먼저, 쓰고 있는 AI를 연결해요'
const FOLDER_STEP = 'text=논문을 담을 폴더를 골라요'
/** 로그인 창을 띄워 둔 동안의 상태 문구 — 기다리는 중인지 사건으로 확인한다. */
const LOGGING_IN = '브라우저에서 로그인한 뒤 이 창으로 돌아와 주세요'
/** 도우미가 없는 새 폴더(revision 0) — 첫 마디가 `이어서 하기`가 아니라 `시작하기`가 된다. */
const synthProjectNoContent = (): string => synthProject({ withContent: false })
const settings = (userData: string) => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf-8'))
// 확인용 캡처는 `KNUAF_SHOTS_DIR` 로 받는다. 없으면 **저장소 밖 설계 폴더가 아니라**
// git 이 무시하는 `app/test-results` 아래에 남긴다 — 저장소 안(`docs/images/`)에는 쓰지 않는다.
// 예전에는 설계 폴더를 기본값으로 두고 그 존재 여부를 파일 머리에서 `test.skip` 으로 봤는데,
// 그러면 그 폴더가 없는 CI(맥·윈도우 모두)에서 **온보딩 15건이 통째로** 사라졌다(2026-10-18 지적).
const SHOTS = process.env.KNUAF_SHOTS_DIR ?? resolve(__dirname, '..', 'test-results', 'onboarding-shots')
/** 캡처 시험 **전용** skip — 자리를 콕 집어 준 경우에만 그 자리를 따진다. 나머지 시험은 언제나 돈다. */
const noShots = process.env.KNUAF_SHOTS_DIR !== undefined && !existsSync(dirname(SHOTS))
const noTool = () => {
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
  return { userData, env: { KNUAF_AGENT_PATH_ONLY: '1', PATH: '', HOME: home } }
}
/**
 * 등장 애니메이션이 **끝난 뒤** 찍는다. 폴더 목록(`.projects.stagger`)은 카드마다 조금씩
 * 늦게 나타나므로, 화면이 보이자마자 찍으면 카드가 흐린 채로 남는다(설계자 대조 지적 —
 * 실제로 어둡게 캡처의 '최근' 카드가 거의 안 보였다). 무한 반복 애니메이션(스피너)은
 * 끝나지 않으므로 기다리지 않는다.
 */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined))
  ))
}
/** 설정에 최근 폴더 하나를 심은 userData — 2단계에서 그 카드를 눌러 폴더를 연다. */
function userDataWithRecent(dir: string, root: string, patch: Record<string, unknown> = {}): string {
  const userData = join(dir, 'userdata')
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({
    show_intro: false, recent: [{ root, opened_at: new Date().toISOString() }], ...patch
  }), 'utf-8')
  return userData
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

/** 화면 캡처 — 자리를 콕 집어 준 경우에만 그 자리를 따진다(위 `noShots`). */
for (const scheme of ['light', 'dark'] as const) {
  test(`첫 실행 화면 캡처 (${scheme}) — 도구 없음`, async () => {
    test.skip(noShots, 'capture destination is outside this checkout')
    const { userData, env } = noTool()
    const { electronApp, page } = await launch({ userData, onboarded: false, colorScheme: scheme, waitFor: INTRO, env })
    await page.setViewportSize({ width: 1180, height: 800 })
    await settled(page)
    mkdirSync(SHOTS, { recursive: true })
    const file = join(SHOTS, `step1-no-tool-${scheme}.png`)
    await page.screenshot({ path: file })
    console.log('captured', file, statSync(file).size, 'bytes')
    await electronApp.close()
  })
}

// ---------------------------------------------------------------------------
// 가짜 서버로 만드는 장면 — 로그인 전이·2단계·첫 대화·건너뛰기
// ---------------------------------------------------------------------------

test('가짜 서버로 로그인하면 연결되고, 2단계에서 고른 폴더가 첫 대화를 시작한다', async () => {
  const dir = scratch()
  const root = synthProjectNoContent()
  const state = join(dir, 'codex-login.txt')
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-out', FAKE_CODEX_STATE: state, FAKE_CODEX_REPLY: replyFile(dir, '안녕하세요. 창업논문을 같이 쓸 도우미예요.') })
  const userData = userDataWithRecent(dir, root)
  const { electronApp, page } = await launch({ userData, onboarded: false, waitFor: INTRO, env })
  try {
    // ① 로그인이 필요하다고 말하고, 로그인 단추를 준다.
    await expect(page.locator('text=ChatGPT 계정 로그인이 필요해요')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'ChatGPT로 로그인' }).click()
    // 브라우저 왕복을 기다리는 동안 그 사실을 말한다.
    await expect(page.locator('text=브라우저에서 로그인한 뒤 이 창으로 돌아와 주세요')).toBeVisible()
    // 상태 확인 폴링(3초)이 연결을 알아본다 — 가짜 서버는 로그인 시작을 상태 파일로 기억한다.
    await expect(page.locator('text=연결됐어요').first()).toBeVisible({ timeout: 30_000 })
    // 로그인한 것 자체가 선택이다 — 그 선택이 기록된다(설정 라디오와 같은 자격).
    await expect.poll(() => settings(userData).provider_choice?.provider).toBe('codex')

    // ② 폴더 단계로 넘어가 최근 목록에서 폴더를 연다.
    await page.getByRole('button', { name: ONBOARD.connectNext }).click()
    await expect(page.locator(FOLDER_STEP)).toBeVisible()
    await page.locator('.project').first().click()

    // ③ 앱 화면으로 넘어가고, 대화가 비어 있었으니 첫 마디가 저절로 한 번 나간다.
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    await expect(page.locator('.chat-msg.user')).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator('.chat-msg.user').first()).toContainText('시작하기')
    // 첫 실행 화면을 지났음이 기록된다 — 다음 실행에는 다시 묻지 않는다.
    expect(settings(userData).onboarded_at).toBeTruthy()
    // 자동으로 두 번 보내지 않는다.
    await page.waitForTimeout(1500)
    await expect(page.locator('.chat-msg.user')).toHaveCount(1)
  } finally {
    await electronApp.close()
  }
})

// ---------------------------------------------------------------- 둘 다 연결 (W2)

/** 연결 한 줄의 지금 문구. */
const row = (page: Page, provider: 'codex' | 'claude') => page.locator(`[data-provider="${provider}"] .reason`).first()

test('GPT 로그인을 기다리는 중에 Claude 로그인을 시작해도 둘 다 연결된다 (완료조건 1)', async () => {
  // W1 재현 ② 그대로: GPT 로그인 응답이 아직 안 끝난 창에서 Claude 로그인을 시작한다.
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, {
    FAKE_CODEX_MODE: 'logged-out', FAKE_CODEX_STATE: join(dir, 'codex-login.txt'), FAKE_CODEX_DELAY_MS: '4000'
  })
  writeStatefulClaude(bin, join(dir, 'claude-login.txt'))
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const { electronApp, page } = await launch({ userData, onboarded: false, waitFor: INTRO, env })
  try {
    await expect(row(page, 'codex')).toContainText('로그인이 필요해요', { timeout: 30_000 })
    await page.getByRole('button', { name: 'ChatGPT로 로그인' }).click()
    await expect(row(page, 'codex')).toContainText(LOGGING_IN)
    await page.getByRole('button', { name: 'Claude로 로그인' }).click()
    // 둘 다 끝난다 — 늦게 확인된 쪽도 "로그인 중"에 남지 않는다.
    await expect(row(page, 'claude')).toContainText('연결됐어요', { timeout: 30_000 })
    await expect(row(page, 'codex')).toContainText('연결됐어요', { timeout: 30_000 })
    // 먼저 성공한 Claude 가 선택되고, 나중에 연결된 GPT 는 그 선택을 바꾸지 않는다(W2 D3).
    await expect.poll(() => settings(userData).provider_choice?.provider).toBe('claude')
    await expect(page.locator('[data-provider="codex"]').getByRole('button', { name: ONBOARD.startWith })).toBeVisible()
    await expect(page.getByRole('button', { name: ONBOARD.connectNext })).toBeEnabled()
  } finally {
    await electronApp.close()
  }
})

test('Claude 로그인을 기다리는 중에 GPT 로그인을 시작해도 둘 다 연결된다 (완료조건 1, 역순)', async () => {
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, {
    FAKE_CODEX_MODE: 'logged-out', FAKE_CODEX_STATE: join(dir, 'codex-login.txt'), FAKE_CODEX_DELAY_MS: '4000'
  })
  writeStatefulClaude(bin, join(dir, 'claude-login.txt'))
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const { electronApp, page } = await launch({ userData, onboarded: false, waitFor: INTRO, env })
  try {
    await expect(row(page, 'claude')).toContainText('로그인이 필요해요', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Claude로 로그인' }).click()
    await expect(row(page, 'claude')).toContainText(LOGGING_IN)
    // Claude 폴링이 도는 동안 GPT 로그인을 시작한다 — 예전에는 이 시작이 Claude 감시를 끊었다.
    await page.getByRole('button', { name: 'ChatGPT로 로그인' }).click()
    await expect(row(page, 'claude')).toContainText('연결됐어요', { timeout: 30_000 })
    await expect(row(page, 'codex')).toContainText('연결됐어요', { timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})

test('이미 고른 AI 가 연결돼 있으면 새로 연결한 쪽이 선택을 빼앗지 않는다 (완료조건 4)', async () => {
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in' })
  writeStatefulClaude(bin, join(dir, 'claude-login.txt'))
  const userData = userDataWithRecent(dir, synthProjectNoContent(), {
    provider_choice: { provider: 'codex', at: new Date().toISOString() }
  })
  const { electronApp, page } = await launch({ userData, onboarded: false, waitFor: INTRO, env })
  try {
    // codex 만 연결돼 있으므로 1단계에 남는다(D2) — Claude 로그인 단추가 여기 있다.
    await expect(row(page, 'claude')).toContainText('로그인이 필요해요', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Claude로 로그인' }).click()
    await expect(row(page, 'claude')).toContainText('연결됐어요', { timeout: 30_000 })
    // 선택은 codex 그대로, Claude 행에는 "이걸로 시작"이 뜬다.
    await expect.poll(() => settings(userData).provider_choice?.provider).toBe('codex')
    await expect(page.locator('[data-provider="claude"]').getByRole('button', { name: ONBOARD.startWith })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('둘 다 연결됐고 저장된 선택이 있으면 조회 순서와 무관하게 2단계로 건너뛴다 (완료조건 4-1)', async () => {
  // codex 상태 응답만 늦춘다 — claude 가 먼저 connected 로 와도 판정을 미뤄야 한다(R1-D01).
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_DELAY_MS: '2000' })
  writeFakeClaude(join(dir, 'bin'))
  const userData = userDataWithRecent(dir, synthProjectNoContent(), {
    provider_choice: { provider: 'codex', at: new Date().toISOString() }
  })
  const { electronApp, page } = await launch({ userData, onboarded: false, waitFor: FOLDER_STEP, env })
  try {
    await expect(page.locator(FOLDER_STEP)).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(INTRO)).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('선택 없이 둘을 연달아 로그인하고 한쪽을 취소해도 먼저 성공한 쪽이 선택된다 (완료조건 4-2)', async () => {
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, {
    FAKE_CODEX_MODE: 'logged-out', FAKE_CODEX_STATE: join(dir, 'codex-login.txt'), FAKE_CODEX_DELAY_MS: '4000'
  })
  writeStatefulClaude(bin, join(dir, 'claude-login.txt'))
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const { electronApp, page } = await launch({ userData, onboarded: false, waitFor: INTRO, env })
  try {
    await expect(row(page, 'codex')).toContainText('로그인이 필요해요', { timeout: 30_000 })
    await page.getByRole('button', { name: 'ChatGPT로 로그인' }).click()
    await expect(row(page, 'codex')).toContainText(LOGGING_IN)
    await page.getByRole('button', { name: 'Claude로 로그인' }).click()
    // Claude 를 취소해도 GPT 로그인은 살아 있어야 한다.
    await page.locator('[data-provider="claude"]').getByRole('button', { name: ONBOARD.cancel }).click()
    await expect(row(page, 'claude')).toContainText('로그인이 필요해요', { timeout: 30_000 })
    await expect(row(page, 'codex')).toContainText('연결됐어요', { timeout: 30_000 })
    await expect.poll(() => settings(userData).provider_choice?.provider).toBe('codex')
    await expect(page.getByRole('button', { name: ONBOARD.connectNext })).toBeEnabled()
  } finally {
    await electronApp.close()
  }
})

test('둘 다 연결돼 있어도 고른 적이 없으면 선택 화면을 보여 준다', async () => {
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in' })
  writeFakeClaude(bin)
  const { electronApp, page } = await launch({ userData: mkdtempSync(join(tmpdir(), 'kd-ud-')), onboarded: false, waitFor: INTRO, env })
  try {
    // 건너뛰지 않는다: 연결된 것이 있어도 "쓸 AI"는 학생이 고른다.
    await expect(page.locator(INTRO)).toBeVisible()
    await expect(page.locator('text=연결됐어요')).toHaveCount(2, { timeout: 30_000 })
    // 고르기 전에는 다음으로 갈 수 없다.
    await expect(page.getByRole('button', { name: ONBOARD.connectNext })).toBeDisabled()
    await page.getByRole('button', { name: ONBOARD.startWith }).first().click()
    await expect(page.locator(FOLDER_STEP)).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('고른 AI 와 다른 AI 가 **둘 다** 연결돼 있으면 1단계를 건너뛴다', async () => {
  // W2 D2 — 1단계에서 더 할 일이 없을 때만 건너뛴다. 예전에는 고른 것 하나만 연결돼 있어도
  // 건너뛰어, 둘 다 연결하려던 학생에게서 다른 쪽 로그인 단추를 빼앗았다.
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in' })
  writeFakeClaude(bin)
  const userData = userDataWithRecent(dir, synthProjectNoContent(), {
    provider_choice: { provider: 'claude', at: new Date().toISOString() }
  })
  const { electronApp, page } = await launch({ userData, onboarded: false, waitFor: FOLDER_STEP, env })
  try {
    // 곧바로 폴더 단계다 — 연결 화면은 지나갔다.
    await expect(page.locator(FOLDER_STEP)).toBeVisible()
    await expect(page.locator(INTRO)).toHaveCount(0)
    await expect(page.locator('text=AI 연결 ✓')).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('고른 AI 만 연결돼 있으면 1단계에 남아 다른 AI 를 연결할 수 있다 (완료조건 3)', async () => {
  // 저장된 선택(codex)은 연결됐지만 Claude 는 아직이다 — 화면을 열자마자 폴더 단계로 튀면
  // Claude 로그인 단추가 사라진다(형님이 본 증상 ①). 수동 [다음] 은 그대로 허용된다.
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in' })
  writeFakeClaude(bin, false)
  const userData = userDataWithRecent(dir, synthProjectNoContent(), {
    provider_choice: { provider: 'codex', at: new Date().toISOString() }
  })
  const { electronApp, page } = await launch({ userData, onboarded: false, waitFor: INTRO, env })
  try {
    await expect(page.locator(INTRO)).toBeVisible()
    await expect(page.locator('text=논문을 담을 폴더를 골라요')).toHaveCount(0)
    // 두 행이 다 있고, Claude 쪽에 로그인 단추가 있다.
    await expect(page.locator('.choices > .item')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Claude로 로그인' })).toBeVisible()
    // 고른 것이 연결돼 있으므로 [다음] 은 열려 있다 — 둘 다 연결을 강요하지 않는다.
    const next = page.getByRole('button', { name: ONBOARD.connectNext })
    await expect(next).toBeEnabled()
    await next.click()
    await expect(page.locator(FOLDER_STEP)).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('저장된 선택만으로는 다음 단계로 가지 못한다 (P2-R1-03)', async () => {
  // 검토 재현: 빈 PATH·PATH 한정 탐색 + 저장된 선택만 있는 설정. 어떤 도구도 발견되지 않는다.
  const dir = scratch()
  const userData = join(dir, 'userdata')
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({
    show_intro: false, provider_choice: { provider: 'claude', at: '2026-10-18T00:00:00.000Z' }
  }), 'utf-8')
  const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
  const { electronApp, page } = await launch({
    userData, onboarded: false, waitFor: INTRO,
    env: { KNUAF_AGENT_PATH_ONLY: '1', PATH: '', HOME: home }
  })
  try {
    await expect(page.locator('text=연결 도구(Claude Code)를 먼저 설치해요')).toBeVisible()
    // 고른 적이 있다는 사실만으로는 넘어가지 못한다 — 지금 연결돼 있어야 한다.
    await expect(page.getByRole('button', { name: ONBOARD.connectNext })).toBeDisabled()
    await expect(page.locator(FOLDER_STEP)).toHaveCount(0)
    await expect(page.locator('text=AI 연결 ✓')).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('확인 실패는 첫 화면과 폴더 화면 모두에서 로그인 필요가 아니다 (P2-R1-01)', async () => {
  // 검토 재현: `claude auth status` 가 JSON 이 아닌 것을 뱉는 가짜 CLI. 도구는 있는데
  // 대답을 못 들은 상태다 — 로그인을 요구하면 엉뚱한 재인증을 시킨다.
  const dir = scratch()
  const bin = join(dir, 'bin')
  writeCliShim(bin, 'claude', 'echo invalid-json', 'echo invalid-json')
  const env = { PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), KNUAF_AGENT_PATH_ONLY: '1' }
  const root = synthProjectNoContent()
  const userData = userDataWithRecent(dir, root, {
    provider_choice: { provider: 'claude', at: '2026-10-18T00:00:00.000Z' }, helper_mode: 'claude-chat'
  })
  const { electronApp, page } = await launch({ userData, env })
  try {
    // ① 첫 화면(1단계, FirstRun→ConnectRow) — 확인 실패를 로그인으로 접지 않는다.
    await expect(page.locator('[data-provider="claude"] .reason').first()).toContainText('연결 상태를 확인하지 못했어요', { timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Claude 로그인' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '다시 확인' }).first()).toBeVisible()

    // ② 같은 시험에서 논문을 **실제로 연다** — 폴더 안 Chat 의 상태 소비 경로도 검사한다
    //    (검토 QA-R1-01: 두 화면은 `useConnect` 와 `useChat.statusInfo` 라는 별도 경로다).
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    await expect(page.locator('text=도우미 상태를 확인하지 못했어요')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Claude 로그인' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '다시 확인' }).first()).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('여는 화면은 첫 실행 화면 **위에** 뜬다 (순서가 뒤집히지 않는다)', async () => {
  // 여는 화면(크레딧)은 앱 전체 위에 얹힌다 — 그 뒤에 첫 실행 화면이 이미 서 있어야
  // 크레딧이 걷힌 뒤 빈 화면이 한 번 보이는 일이 없다(App.tsx 의 렌더 순서).
  const { userData, env } = noTool()
  const { electronApp, page } = await launch({ userData, onboarded: false, intro: true, waitFor: '[data-intro]', env })
  try {
    await expect(page.locator('[data-intro]')).toHaveCount(1)
    // 같은 순간에 뒤에 첫 실행 화면이 서 있다 — 여는 화면이 걷히면 이것이 남는다.
    await expect(page.locator(INTRO)).toHaveCount(1)
  } finally {
    await electronApp.close()
  }
})

test('이미 지난 학생이 다시 켜면 폴더 화면(첫 실행 2단계)부터 본다', async () => {
  // 발주 QA 재실행 결정 — 재실행 첫 화면은 시안 ② 논문 폴더 화면이다(온보딩 2단계와 같은 부품).
  // 폴더 단계로 건너뛰려면 **둘 다** 연결이 확인돼 있어야 하므로(W2 D2) 가짜 codex·claude 를 쓴다.
  const dir = scratch()
  const root = synthProjectNoContent()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  writeFakeClaude(join(dir, 'bin'))   // 둘 다 연결돼야 자동 건너뛰기가 선다(W2 D2)
  const userData = userDataWithRecent(dir, root, { provider_choice: { provider: 'codex', at: new Date().toISOString() } })
  const { electronApp, page } = await launch({ userData, env, waitFor: FOLDER_STEP })
  try {
    // 길잡이가 "AI 연결 ✓ → 논문 폴더 → 시작"으로 선다 — 1단계는 지나갔다.
    await expect(page.locator(FOLDER_STEP)).toBeVisible()
    await expect(page.locator('.onb-way')).toContainText('AI 연결 ✓')
    // 첫 실행 인트로(로그인 벽)는 뜨지 않는다.
    await expect(page.locator(INTRO)).toHaveCount(0)
    await page.locator('.project').first().click()
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})

/** 연결 장면 캡처 — 1단계(둘 다 연결됨)와 2단계. */
for (const scheme of ['light', 'dark'] as const) {
  test(`연결된 첫 실행 화면 캡처 (${scheme})`, async () => {
    test.skip(noShots, 'capture destination is outside this checkout')
    const dir = scratch()
    const bin = join(dir, 'bin')
    const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in' })
    writeFakeClaude(bin)
    const userData = userDataWithRecent(dir, synthProjectNoContent())
    const { electronApp, page } = await launch({ userData, onboarded: false, colorScheme: scheme, waitFor: INTRO, env })
    await page.setViewportSize({ width: 1180, height: 800 })
    await expect(page.locator('text=연결됐어요')).toHaveCount(2, { timeout: 30_000 })
    await settled(page)
    mkdirSync(SHOTS, { recursive: true })
    const one = join(SHOTS, `step1-connected-${scheme}.png`)
    await page.screenshot({ path: one })
    console.log('captured', one, statSync(one).size, 'bytes')
    await page.getByRole('button', { name: ONBOARD.startWith }).first().click()
    await expect(page.locator(FOLDER_STEP)).toBeVisible()
    await expect(page.locator('.project').first()).toBeVisible()   // 목록이 다 그려진 뒤에
    await settled(page)
    const two = join(SHOTS, `step2-folder-${scheme}.png`)
    await page.screenshot({ path: two })
    console.log('captured', two, statSync(two).size, 'bytes')
    await electronApp.close()
  })
}
