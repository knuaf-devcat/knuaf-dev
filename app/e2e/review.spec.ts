/**
 * 발주 QA2-B e2e — ①종이에서 골라 "고쳐 달라기"(N-I03) ②고친 부분 보기(N-I04).
 *
 * 실제 Electron 앱을 띄운다(`launch()` 가 숨김 실행). 도우미는 가짜 `codex app-server` 로
 * 고정하므로 개발 기계의 진짜 CLI 와 무관하게 같은 장면이 된다. 파일을 만지는 것은
 * `synthProject`/`rewriteSection` 뿐이고 실제 AI 호출·로그인은 없다.
 */
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, rewriteSection, synthProject } from './helpers'
import { fakeCodexEnv, questionMessage, questionProject, scratch, seedChat } from './fixtures/fake-codex'
import { CHAT } from '../src/renderer/src/copy'

const COMPOSER = `textarea[placeholder="${CHAT.placeholder}"]`
const BODY_800 = '농장A의 재배 면적은 800평이다. 정읍 일대 기후를 고려해 작목을 선택했다.'

/** 파싱된 챗 로그의 학생 메시지 텍스트들 — 가짜 서버가 받은 그대로다. */
function userTexts(root: string): string[] {
  try {
    const s = JSON.parse(readFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), 'utf-8')) as { messages?: { role: string; text: string }[] }
    return (s.messages ?? []).filter((m) => m.role === 'user').map((m) => m.text)
  } catch {
    return []
  }
}

/** 종이의 한 문단을 통째로 고르고 마우스를 뗀 것처럼 한다(선택 → 행동 막대). */
async function selectParagraph(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    const p = [...document.querySelectorAll('.sheet p')].find((el) => (el.textContent ?? '').includes(text))
    if (!p) throw new Error(`문단을 찾지 못했다: ${text}`)
    const range = document.createRange()
    range.selectNodeContents(p)
    const sel = window.getSelection()
    if (!sel) throw new Error('선택을 만들 수 없다')
    sel.removeAllRanges(); sel.addRange(range)
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, needle)
}

test('종이에서 문장을 고르면 행동 막대가 뜨고, 고쳐 달라기가 인용을 붙여 보낸다', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const sheet = page.locator('.paperpane .sheet')
    await expect(sheet).toContainText('600평', { timeout: 30_000 })
    // 연결이 확인돼 입력칸이 서야 아래 칸이 "composer" 다 — 그 전에는 행동 막대가 뜨지 않는다.
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })

    // 고르기 전에는 막대가 없다.
    await expect(page.locator('.selbar')).toHaveCount(0)
    await selectParagraph(page, '600평')

    // 선택 위에 행동 막대 — 고쳐 달라기 · 복사.
    const bar = page.locator('.selbar')
    await expect(bar).toBeVisible()
    await expect(bar.getByRole('button', { name: '고쳐 달라기' })).toBeVisible()
    await expect(bar.getByRole('button', { name: '복사' })).toBeVisible()

    // 고쳐 달라기 → 입력칸 위 인용 칩(장 이름 + 문장).
    await bar.getByRole('button', { name: '고쳐 달라기' }).click()
    await expect(bar).toHaveCount(0)
    const chip = page.locator('.review-chip')
    await expect(chip).toBeVisible()
    await expect(chip).toContainText('Ⅰ. 머리말에서 고른 문장')
    await expect(chip).toContainText('농장A의 재배 면적은 600평이다.')
    // 자리도 규칙이다 — 칩은 **입력칸 위**에 있다(아래가 아니라).
    const chipBox = await chip.boundingBox()
    const composerBox = await page.locator('.chat-composer').boundingBox()
    expect(chipBox).not.toBeNull()
    expect(composerBox).not.toBeNull()
    expect(chipBox!.y + chipBox!.height).toBeLessThanOrEqual(composerBox!.y + 1)

    // 인용 + 학생 글이 합쳐져 보낸다 — 보낸 메시지를 가짜 서버 로그로 확인한다.
    // (학생 글이 빈 경우의 "이 부분을 고쳐 줘"는 review-diff.spec.ts 단위 시험이 본다 —
    //  빈 초안으로는 보내기 단추가 잠겨 있어(입력칸 소유자 A 의 몫) 화면으로는 밟을 수 없다.)
    await page.locator(COMPOSER).fill('단위를 kg으로 바꿔 줘')
    await page.locator('.chat-composer button.send').click()
    await expect.poll(() => userTexts(root), { timeout: 30_000 })
      .toEqual(['> 농장A의 재배 면적은 600평이다. 정읍 일대 기후를 고려해 작목을 선택했다.\n(Ⅰ. 머리말에서)\n\n단위를 kg으로 바꿔 줘'])
    // 보낸 뒤 인용은 사라진다(두 번 붙지 않는다).
    await expect(chip).toHaveCount(0)

    // 다시 고르면 다시 붙는다 — 상태가 한 번 쓰고 사라지지 않는다.
    await selectParagraph(page, '600평')
    const again = page.locator('.selbar')
    await expect(again).toBeVisible({ timeout: 15_000 })
    await again.getByRole('button', { name: '고쳐 달라기' }).click()
    await expect(page.locator('.review-chip')).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('질문 카드가 떠 있으면 행동 막대를 띄우지 않는다', async () => {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [questionMessage()])
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    // 질문 카드가 아래 칸을 차지한다.
    await expect(page.locator('.qcard')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.paperpane .sheet')).toContainText('600평', { timeout: 30_000 })

    await selectParagraph(page, '600평')
    // 선택은 됐지만 카드가 자리를 쓰므로 막대는 뜨지 않는다.
    expect(await page.locator('.selbar').count()).toBe(0)
    expect(await page.locator('.review-chip').count()).toBe(0)
  } finally {
    await electronApp.close()
  }
})

test('고친 부분 보기 — 600평→800평 저장 뒤 지움 1·새것 1, 끄면 지금 본문', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const sheet = page.locator('.paperpane .sheet')
    await expect(sheet).toContainText('600평', { timeout: 30_000 })
    // 아직 바뀐 절이 없다 — 토글이 보이지 않는다.
    await expect(page.locator('.review-toggle')).toHaveCount(0)

    // 도우미가 800평으로 다시 저장한다(기록 1→2). 앱은 감시로 곧 따라온다.
    rewriteSection(root, { body: BODY_800, expected: 1 })
    await expect(sheet).toContainText('800평', { timeout: 30_000 })

    const toggle = page.locator('.review-toggle')
    await expect(toggle).toBeVisible()
    await toggle.click()

    // 지운 문장 1(600평) · 새 문장 1(800평), 나머지 문장은 그대로.
    await expect(sheet.locator('del.rev-del')).toHaveCount(1)
    await expect(sheet.locator('ins.rev-ins')).toHaveCount(1)
    await expect(sheet.locator('del.rev-del')).toContainText('600평')
    await expect(sheet.locator('ins.rev-ins')).toContainText('800평')
    await expect(sheet).toContainText('정읍 일대 기후를 고려해 작목을 선택했다.')

    // 끄면 지금 본문으로 돌아온다.
    await toggle.click()
    await expect(sheet.locator('del.rev-del')).toHaveCount(0)
    await expect(sheet.locator('ins.rev-ins')).toHaveCount(0)
    await expect(sheet).toContainText('800평')
  } finally {
    await electronApp.close()
  }
})
