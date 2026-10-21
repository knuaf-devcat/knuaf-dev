/**
 * 발주 QA2-B e2e — ①종이에서 골라 "고쳐 달라기"(N-I03) ②고친 부분 보기(N-I04).
 *
 * 실제 Electron 앱을 띄운다(`launch()` 가 숨김 실행). 도우미는 가짜 `codex app-server` 로
 * 고정하므로 개발 기계의 진짜 CLI 와 무관하게 같은 장면이 된다. 파일을 만지는 것은
 * `synthProject`/`rewriteSection` 뿐이고 실제 AI 호출·로그인은 없다.
 */
import { expect, test, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, openProject, python, rewriteSection, scripts, synthProject, PROGRESS } from './helpers'
import { fakeCodexEnv, questionMessage, questionProject, scratch, seedChat } from './fixtures/fake-codex'
import { CHAT } from '../src/renderer/src/copy'

const COMPOSER = `textarea[aria-label="${CHAT.placeholder}"]`
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

/** 그 글자를 담은 **가장 안쪽 요소**를 고른다 — 비교 모드의 `del.rev-del` 처럼 문단이 아닌 자리도. */
async function selectText(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    const inside = [...document.querySelectorAll('.sheet *')].filter((el) => (el.textContent ?? '').includes(text))
    const target = inside[inside.length - 1]
    if (!target) throw new Error(`글자를 찾지 못했다: ${text}`)
    const range = document.createRange()
    range.selectNodeContents(target)
    const sel = window.getSelection()
    if (!sel) throw new Error('선택을 만들 수 없다')
    sel.removeAllRanges(); sel.addRange(range)
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, needle)
}

/** 절 **제목만** 바꾼다(id·본문 경로·본문 내용은 그대로) — 본문 해시가 같아 묵은 선택이 살아남는 경로. */
function retitleSection(root: string, title: string, expected: number): void {
  const change = join(root, `change-retitle-${expected}.json`)
  writeFileSync(change, JSON.stringify({ request_id: `e2e:retitle:${expected}`, ops: [
    { collection: 'sections', value: { id: 'sec-01', title, order: 1, path: 'sections/01.md', status: 'drafting' } }
  ] }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(expected)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
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

test('인용만 있어도 보낼 수 있다 — 빈 초안에서 보내면 "이 부분을 고쳐 줘" (잠금 완화)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    // 종이 본문이 **실제로 그려진 뒤**에 고른다 — 입력칸만 보고 고르면 절 목록을 읽기 전에
    // "문단을 찾지 못했다"로 깨진다(맥 CI). 같은 의미의 기다림을 더한다.
    await expect(page.locator('.paperpane .sheet')).toContainText('600평', { timeout: 30_000 })
    await selectParagraph(page, '600평')
    await page.locator('.selbar').getByRole('button', { name: '고쳐 달라기' }).click()
    await expect(page.locator('.review-chip')).toBeVisible()

    // 초안은 비어 있다 — 그래도 보내기 단추가 살아 있다(인용만으로 보낸다, 발주 QA2-B §2 (a)).
    const send = page.locator('.chat-composer button.send')
    await expect(send).toBeEnabled()
    await send.click()
    await expect.poll(() => userTexts(root), { timeout: 30_000 })
      .toEqual(['> 농장A의 재배 면적은 600평이다. 정읍 일대 기후를 고려해 작목을 선택했다.\n(Ⅰ. 머리말에서)\n\n이 부분을 고쳐 줘'])
    // 보낸 뒤 인용은 사라진다.
    await expect(page.locator('.review-chip')).toHaveCount(0)
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

test('작업 중에 고른 선택은 작업이 끝나면 막대가 뜬다 — 다시 고르지 않아도', async () => {
  // 맥 CI 실패 처방(FIX-CI-MAC-R2 실패 1): 도우미가 아직 작업 중일 때 고르면 선택을 버려서
  // 작업이 끝난 뒤 처음부터 다시 골라야 막대가 떴다. 이제는 숨기기만 하고 선택을 지킨다.
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_HOLD: '1' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.paperpane .sheet')).toContainText('600평', { timeout: 30_000 })

    // 도우미를 일하게 만든다 — 가짜 서버가 턴을 끝내지 않는다(작업 중 상태 유지).
    await page.locator(COMPOSER).fill('작업을 시작해 주세요')
    await page.locator('.chat-composer button.send').click()
    await expect(page.locator(PROGRESS)).toHaveCount(1, { timeout: 30_000 })   // 작업 중(진행 표시 하나)
    await expect(page.locator(PROGRESS)).toBeVisible()

    // 작업 중에 고른다 — 막대는 뜨지 않지만 선택은 버려지지 않는다.
    await selectParagraph(page, '600평')
    await expect(page.locator('.selbar')).toHaveCount(0)

    // 작업을 끝낸다(같은 자리가 중단 단추) → 입력칸이 돌아오면 다시 고르지 않아도 막대가 뜬다.
    await page.locator('.chat-composer button.send').click()
    await expect(page.locator(PROGRESS)).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator('.selbar'), '작업이 끝났는데 그 선택 위에 막대가 뜨지 않는다').toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.selbar').getByRole('button', { name: '고쳐 달라기' })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('본문이 바뀌면 묵은 행동 막대가 남지 않는다', async () => {
  // 저장·절 교체로 종이가 다시 그려지면 담아 둔 선택은 더 이상 그 글자가 아니다.
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const sheet = page.locator('.paperpane .sheet')
    await expect(sheet).toContainText('600평', { timeout: 30_000 })
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    await selectParagraph(page, '600평')
    await expect(page.locator('.selbar')).toBeVisible()

    // 도우미가 그 절을 다시 저장한다 → 종이가 다시 그려진다.
    rewriteSection(root, { body: BODY_800, expected: 1 })
    await expect(sheet).toContainText('800평', { timeout: 30_000 })
    await expect(page.locator('.selbar'), '본문이 바뀌었는데 묵은 막대가 남아 있다').toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('비교 모드를 끄면 화면에서 사라진 옛 문장은 막대·인용으로 남지 않는다 (MACR2-R1-01 A)', async () => {
  // 검토 반례 A: 비교 화면의 지운 문장(600평)을 고른 뒤 비교를 끄면, 그 글자가 화면에 없는데도
  // 작업이 끝날 때 막대가 남아 옛 문장을 인용할 수 있었다. 담아 둔 선택은 "그 글자가 지금 화면에
  // 그대로 골라져 있을 때"만 유효하다.
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_HOLD: '1' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const sheet = page.locator('.paperpane .sheet')
    await expect(sheet).toContainText('600평', { timeout: 30_000 })
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })

    // 800평으로 저장하고 비교를 켠다 — 지운 600평 문장이 화면에 있다.
    rewriteSection(root, { body: BODY_800, expected: 1 })
    await expect(sheet).toContainText('800평', { timeout: 30_000 })
    const toggle = page.locator('.review-toggle')
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(sheet.locator('del.rev-del'), '지운 문장이 비교 화면에 없다').toContainText('600평', { timeout: 30_000 })

    // 도우미를 작업 중으로 둔다(막대가 숨는 구역).
    await page.locator(COMPOSER).fill('작업을 시작해 주세요')
    await page.locator('.chat-composer button.send').click()
    await expect(page.locator(PROGRESS)).toHaveCount(1, { timeout: 30_000 })   // 작업 중(진행 표시 하나)
    await expect(page.locator(PROGRESS)).toBeVisible()

    // 비교 화면의 **지운 문장**을 고른다 — 작업 중이라 막대는 뜨지 않는다.
    await selectText(page, '600평')
    await expect(page.locator('.selbar')).toHaveCount(0)

    // 비교를 끈다 → 그 문장이 화면에서 사라진다.
    await toggle.click()
    await expect(sheet.locator('del.rev-del')).toHaveCount(0)

    // 작업을 끝낸다 → 다시 고르지 않았으니 막대도 인용도 없어야 한다.
    await page.locator('.chat-composer button.send').click()
    await expect(page.locator('.chat-composer button.send')).toHaveAttribute('aria-label', CHAT.send, { timeout: 30_000 })
    await expect(page.locator('.selbar'), '화면에 없는 옛 문장으로 막대가 남았다').toHaveCount(0)
    // 늦게 그려지는 경우까지 본다(막대는 어느 시점에도 0).
    await page.waitForTimeout(400)
    await expect(page.locator('.selbar')).toHaveCount(0)
    await expect(page.locator('.review-chip')).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('절 제목만 바뀌어도 인용 출처는 지금 제목을 쓴다 (MACR2-R1-01 B)', async () => {
  // 검토 반례 B: 본문 해시가 그대로인 채 절 제목만 바뀌면, 담아 둔 옛 제목이 인용에 붙었다.
  // 본문이 그대로라 선택은 화면에 살아 있으므로 막대는 돌아오되, 출처는 **지금 절 목록**에서 읽는다.
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_HOLD: '1' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const sheet = page.locator('.paperpane .sheet')
    await expect(sheet).toContainText('600평', { timeout: 30_000 })
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })

    // 작업 중으로 둔 뒤 600평 문단을 고른다.
    await page.locator(COMPOSER).fill('작업을 시작해 주세요')
    await page.locator('.chat-composer button.send').click()
    await expect(page.locator(PROGRESS)).toHaveCount(1, { timeout: 30_000 })   // 작업 중(진행 표시 하나)
    await expect(page.locator(PROGRESS)).toBeVisible()
    await selectParagraph(page, '600평')
    await expect(page.locator('.selbar')).toHaveCount(0)

    // 절 **제목만** 바꾼다 — 본문 해시가 같아 선택 무효화(본문 변경)는 서지 않는 경로.
    retitleSection(root, 'Ⅱ. 농장 현황', 1)
    await expect(sheet.locator('h2').first(), '종이 제목이 따라오지 않았다').toContainText('Ⅱ. 농장 현황', { timeout: 30_000 })

    // 작업을 끝낸다 → 선택이 화면에 살아 있으니 막대가 돌아오고, 인용 출처는 지금 제목이다.
    await page.locator('.chat-composer button.send').click()
    await expect(page.locator('.chat-composer button.send')).toHaveAttribute('aria-label', CHAT.send, { timeout: 30_000 })
    const bar = page.locator('.selbar')
    await expect(bar, '본문이 그대로인데 선택이 사라졌다').toBeVisible({ timeout: 15_000 })
    await bar.getByRole('button', { name: '고쳐 달라기' }).click()

    const chip = page.locator('.review-chip')
    await expect(chip).toContainText('Ⅱ. 농장 현황에서 고른 문장')
    await expect(chip, '옛 제목이 인용에 붙었다').not.toContainText('Ⅰ. 머리말')
    await expect(chip).toContainText('600평')
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
