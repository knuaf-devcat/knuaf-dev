/**
 * QA2-B + 통합 검토 R1(REVIEW-ASTRA-QA2B-R1, 차단 4 · 중요 2) 처분 시험.
 *
 * 01 인용 소유권(폴더) · 02 인용 전송의 초안 소비 · 03 비교 기준의 수명 · 04 표 구조 유지 ·
 * 05 문단 통째 삭제 취소선 · 06 실제 드래그 뒤 입력칸 초점. 숨김 실행, 가짜 codex 만.
 */
import { expect, test, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, openProject, python, rewriteSection, scripts, synthProject } from './helpers'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'
import { CHAT } from '../src/renderer/src/copy'

const COMPOSER = `textarea[placeholder="${CHAT.placeholder}"]`
const BODY_800 = '농장A의 재배 면적은 800평이다. 정읍 일대 기후를 고려해 작목을 선택했다.'
const TABLE = (v: string): string => `| 항목 | 면적 |\n| --- | --- |\n| 농장 | ${v}평 |`

/**
 * 절 본문을 갈아 끼운다 — `rewriteSection` 은 request_id 가 고정이라 **한 시험에서 두 번** 쓰면
 * 두 번째가 같은 id 로 접혀 적용되지 않는다(gg 의 멱등). 여기서는 id 를 달리 준다.
 */
function setBody(root: string, body: string, requestId: string, expected: number): void {
  writeFileSync(join(root, 'sections', '01.md'), `# Ⅰ. 머리말\n\n<!-- gg:draft:start -->\n${body}\n<!-- gg:draft:end -->\n`, 'utf-8')
  const change = join(root, `change-${requestId.replace(/[^\w]/g, '-')}.json`)
  writeFileSync(change, JSON.stringify({ request_id: requestId, ops: [
    { collection: 'sections', value: { id: 'sec-01', title: 'Ⅰ. 머리말', order: 1, path: 'sections/01.md', status: 'drafting' } }
  ] }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(expected)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

/** 파싱된 챗 로그의 학생 메시지들 — 가짜 서버가 받은 그대로다. */
function userTexts(root: string): string[] {
  try {
    const s = JSON.parse(readFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), 'utf-8')) as { messages?: { role: string; text: string }[] }
    return (s.messages ?? []).filter((m) => m.role === 'user').map((m) => m.text)
  } catch {
    return []
  }
}

/** 종이의 한 문단을 통째로 고르고 마우스를 뗀 것처럼 한다(DOM Range 경로). */
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

test('인용은 그 논문의 것 — 폴더를 바꾸면 지워지고 다른 논문으로 나가지 않는다 (QA2B-R1-01)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const a = synthProject()   // 600평
  const b = synthProject()   // 다른 논문
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, a)
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    await selectParagraph(page, '600평')
    await page.locator('.selbar').getByRole('button', { name: '고쳐 달라기' }).click()
    await expect(page.locator('.review-chip')).toBeVisible()

    // 다른 논문을 연다 — A 의 인용은 남지 않는다.
    await openProject(page, b)
    await expect(page.locator('.review-chip')).toHaveCount(0)
    // 인용도 초안도 없으니 보낼 수 없다(예전엔 남은 인용만으로 보낼 수 있었다).
    await expect(page.locator('.chat-composer button.send')).toBeDisabled()

    // 일반 글은 인용 없이 B 로 나간다 — B 의 대화 기록에 A 의 문장이 없다.
    await page.locator(COMPOSER).fill('B 논문에 대한 요청')
    await page.locator('.chat-composer button.send').click()
    await expect.poll(() => userTexts(b), { timeout: 30_000 }).toEqual(['B 논문에 대한 요청'])
    expect(userTexts(b).join('\n')).not.toContain('600평')
  } finally {
    await electronApp.close()
  }
})

test('인용 전송은 보낸 초안만 비운다 — 보낸 글이 입력칸에 남지 않는다 (QA2B-R1-02)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    await selectParagraph(page, '600평')
    await page.locator('.selbar').getByRole('button', { name: '고쳐 달라기' }).click()
    await expect(page.locator('.review-chip')).toBeVisible()

    await page.locator(COMPOSER).fill('단위를 kg으로 바꿔 줘')
    await page.locator('.chat-composer button.send').click()
    await expect.poll(() => userTexts(root), { timeout: 30_000 })
      .toEqual(['> 농장A의 재배 면적은 600평이다. 정읍 일대 기후를 고려해 작목을 선택했다.\n(Ⅰ. 머리말에서)\n\n단위를 kg으로 바꿔 줘'])
    // 보낸 글은 입력칸에 남지 않는다(예전엔 그대로 남아 다음 Enter 에 다시 나갈 수 있었다).
    await expect(page.locator(COMPOSER)).toHaveValue('')
    await expect(page.locator('.review-chip')).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('비교 기준은 종이를 닫았다 열어도 남는다 (QA2B-R1-03)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const sheet = page.locator('.paperpane .sheet')
    await expect(sheet).toContainText('600평', { timeout: 30_000 })

    rewriteSection(root, { body: BODY_800, expected: 1 })
    await expect(sheet).toContainText('800평', { timeout: 30_000 })
    await expect(page.locator('.review-toggle')).toBeVisible()

    // 종이를 닫았다 다시 연다(앱은 그대로, 폴더도 그대로).
    await page.getByRole('button', { name: '내 논문 닫기' }).click()
    await expect(page.locator('.paperpane')).toHaveCount(0)
    await page.locator('.tbar-seg').getByRole('tab', { name: '내 논문' }).click()
    await expect(page.locator('.paperpane')).toBeVisible()

    // 기준이 살아 있으니 토글이 다시 서고, 비교가 실제로 된다.
    const toggle = page.locator('.review-toggle')
    await expect(toggle, '종이를 다시 열었더니 비교 기준이 사라졌다').toBeVisible()
    await toggle.click()
    await expect(page.locator('.paperpane .sheet del.rev-del')).toHaveCount(1)
    await expect(page.locator('.paperpane .sheet ins.rev-ins')).toHaveCount(1)
  } finally {
    await electronApp.close()
  }
})

test('비교 모드에서도 표 구조가 유지된다 (QA2B-R1-04)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  // 기준이 표가 되게 먼저 표로 바꿔 두고 연다(처음 읽는 본문 = 표 600평).
  setBody(root, TABLE('600'), 'qa2b:table:1', 1)
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const sheet = page.locator('.paperpane .sheet')
    await expect(sheet.locator('table')).toHaveCount(1, { timeout: 30_000 })

    setBody(root, TABLE('800'), 'qa2b:table:2', 2)
    await expect(sheet).toContainText('800평', { timeout: 30_000 })

    await page.locator('.review-toggle').click()
    // 표가 사라지지 않는다 — 옛 표(취소선)와 새 표가 **둘 다 렌더된 표**다.
    await expect(sheet.locator('table'), '비교 모드에서 표가 마크다운 원문으로 붕괴했다').toHaveCount(2)
    await expect(sheet.locator('.blk.rev-del table')).toHaveCount(1)
    await expect(sheet.locator('.blk.rev-ins table')).toHaveCount(1)
    await expect(sheet.locator('.blk.rev-del')).toContainText('600평')
    await expect(sheet.locator('.blk.rev-ins')).toContainText('800평')
    // 파이프·구분선 원문이 글자로 남지 않는다.
    expect(await sheet.innerText()).not.toContain('| ---')
  } finally {
    await electronApp.close()
  }
})

test('문단을 통째로 지워도 빨강과 취소선이 함께 보인다 (QA2B-R1-05)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  // 기준 = 두 문단. 그 뒤 한 문단을 통째로 지운다 → del 블록(짝 없음).
  setBody(root, '남는 문단이다.\n\n삭제할 문단이다.', 'qa2b:del:1', 1)
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const sheet = page.locator('.paperpane .sheet')
    await expect(sheet).toContainText('삭제할 문단이다', { timeout: 30_000 })

    setBody(root, '남는 문단이다.', 'qa2b:del:2', 2)
    await expect(sheet).not.toContainText('삭제할 문단이다', { timeout: 30_000 })
    await page.locator('.review-toggle').click()

    const del = sheet.locator('.blk.rev-del')
    await expect(del).toHaveCount(1)
    await expect(del).toContainText('삭제할 문단이다')
    expect(await del.evaluate((el) => getComputedStyle(el).textDecorationLine), '문단 전체 삭제에 취소선이 없다').toBe('line-through')
    expect(await del.locator('p').first().evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('line-through')
  } finally {
    await electronApp.close()
  }
})

test('실제 드래그 뒤 고쳐 달라기를 누르면 입력칸이 초점을 받는다 (QA2B-R1-06)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    const p = page.locator('.paperpane .sheet p').first()
    await expect(p).toContainText('600평', { timeout: 30_000 })

    // 실제 마우스 드래그(프로그램적 Range 가 아니라 포인터 이동으로 만든 선택).
    // 첫 줄 안쪽(y+12)에서 끌고, 각 단계 사이에 잠깐 쉰다 — 합성 이동만으로는 선택이 만들어지지 않는다.
    const b = await p.boundingBox()
    const y = b!.y + 12
    await page.mouse.move(b!.x + 4, y)
    await page.mouse.down()
    await page.waitForTimeout(80)
    await page.mouse.move(b!.x + 60, y, { steps: 8 })
    await page.waitForTimeout(80)
    await page.mouse.move(b!.x + 160, y, { steps: 10 })
    await page.waitForTimeout(80)
    await page.mouse.up()
    // 정말 드래그로 골라졌는지부터 확인한다 — 안 골라졌으면 이 시험이 다른 것을 재게 된다.
    const picked = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    expect(picked.length, '드래그로 선택이 만들어지지 않았다').toBeGreaterThan(3)

    const bar = page.locator('.selbar')
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await bar.getByRole('button', { name: '고쳐 달라기' }).click()
    await expect(page.locator('.review-chip')).toBeVisible()
    // 입력칸이 초점을 받아 바로 글을 쓸 수 있다.
    expect(await page.locator(COMPOSER).evaluate((el) => el === document.activeElement), '입력칸으로 초점이 가지 않았다').toBe(true)
  } finally {
    await electronApp.close()
  }
})
