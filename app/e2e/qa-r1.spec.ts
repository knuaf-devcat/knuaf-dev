/**
 * 1차 QA 검토(REVIEW-ASTRA-QA-R1) 처분 시험 — FAIL 4건 중 시험으로 잠그는 것들.
 *
 *   QA-R1-01  onboarding.spec.ts 의 P2-R1-01 시험이 직접 담당한다(첫 화면 + 폴더 안 Chat).
 *   QA-R1-02  입력칸이 허락 카드 뒤 다시 나타나도 5줄 초안 높이가 복구된다.
 *   QA-R1-03  점검 시트 제출용 후보 옆 설명이 14px.
 *   QA-R1-04  경고 배지 글자는 기본 글자색, 호박은 앞의 점으로만.
 *
 * 숨김 실행(`launch()` 기본). 실제 로그인·AI 호출 없음 — 가짜 `codex app-server` 만 쓴다.
 */
import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { launch, navTo, openProject, splitReady, synthProject } from './helpers'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'
import { CHAT } from '../src/renderer/src/copy'

const COMPOSER = `textarea[aria-label="${CHAT.placeholder}"]`

test('허락 카드 뒤 돌아온 입력칸도 5줄 초안 높이를 지킨다 (QA-R1-02)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    // 아래에서 스냅샷을 push 한다 — sidecar `project.status` 가 늦어 열기 뒤 load() 가 push 뒤로 밀리는 경합을 닫으려
    // 두 칸 배치까지 기다린다. 모든 늦은 채팅 조회의 완료 보장은 아니다(retake-ui.spec.ts push 주석, 검토 CI43-R1-02).
    await openProject(page, root, splitReady)
    const ta = page.locator(COMPOSER)
    await expect(ta).toBeVisible({ timeout: 30_000 })
    const draft = ['첫 줄', '둘째 줄', '셋째 줄', '넷째 줄', '다섯째 줄'].join('\n')
    await ta.fill(draft)
    const heightOf = async (): Promise<number> => Math.round(await ta.evaluate((el) => el.getBoundingClientRect().height))
    const grown = await heightOf()
    expect(grown, '5줄 초안인데 입력칸이 자라지 않았다').toBeGreaterThan(100)

    // 실제 preload 구독 채널로 허락 스냅샷을 밀어 넣는다(도구·AI 실행 없음).
    const push = (s: unknown) => electronApp.evaluate(({ BrowserWindow }, snap) => {
      BrowserWindow.getAllWindows()[0].webContents.send('chat:snapshot', snap)
    }, s)
    const messages = [{ id: 'u1', role: 'user', text: draft, at: new Date().toISOString(), delivery: 'sent' }]
    await push({ root, provider: 'codex', state: 'permission', messages, permission: { id: 'p1', title: '명령 실행 확인', detail: 'cat /etc/hosts' } })
    await expect(page.locator('.askcard')).toBeVisible({ timeout: 30_000 })
    await expect(ta).toHaveCount(0)

    // 같은 대화의 idle 스냅샷 — 입력칸이 같은 초안으로 다시 나타난다.
    await push({ root, provider: 'codex', state: 'idle', messages })
    await expect(ta).toBeVisible({ timeout: 30_000 })
    await expect(ta).toHaveValue(draft)
    expect(await heightOf(), '다시 나타난 입력칸이 한 줄 높이로 줄었다').toBeGreaterThan(100)
  } finally {
    await electronApp.close()
  }
})

test('점검 시트 제출용 후보 옆 설명이 14px (QA-R1-03)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await navTo(page, '점검')
    await page.waitForSelector('[data-screen="checkup"]', { timeout: 30_000 })
    const caption = page.locator('[data-screen="checkup"] .chk .row .caption').first()
    await expect(caption).toBeVisible()
    expect(await caption.evaluate((el) => getComputedStyle(el).fontSize)).toBe('14px')
  } finally {
    await electronApp.close()
  }
})

test('경고 배지 글자는 기본 글자색, 호박은 앞의 점으로만 (QA-R1-04)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    // 실제로 배지가 있는 자리를 기다리지 않고 규칙 자체를 프로브로 잰다(결정적).
    const { color, dot } = await page.evaluate(() => {
      const b = document.createElement('span')
      b.className = 'badge warning'
      b.textContent = '경고'
      document.body.appendChild(b)
      const cs = getComputedStyle(b)
      const before = getComputedStyle(b, '::before')
      const out = { color: cs.color, dot: before.backgroundColor }
      b.remove()
      return out
    })
    // --ink-2 = #334155 → rgb(51, 65, 85). 호박(--warn/#7a4e0e, --attn/#a87318)이 아니다.
    expect(color, '경고 배지 글자가 호박색이다').toBe('rgb(51, 65, 85)')
    expect(dot, '앞의 점이 호박색이 아니다').toBe('rgb(168, 115, 24)')
  } finally {
    await electronApp.close()
  }
})
