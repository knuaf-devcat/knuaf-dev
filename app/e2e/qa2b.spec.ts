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
import { launch, openProject, paperReady, python, rewriteSection, scripts, synthProject } from './helpers'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'
import { CHAT } from '../src/renderer/src/copy'

const COMPOSER = `textarea[aria-label="${CHAT.placeholder}"]`
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

/**
 * 종이 배치가 **멈출 때까지** 기다린다(맥 CI 실패 처방, FIX-CI-MAC-DRAG).
 *
 * 빠른 기계(CI 러너)에서는 문단이 화면에 나타난 직후에 좌표를 재면, 그 뒤 절이 더 그려지거나
 * 장 이름 줄이 자리를 잡으면서 **문단이 아래로 밀린다** — 그러면 재어 둔 좌표가 글자 밖(장 이름이나
 * 여백)을 가리켜 포인터 드래그가 선택을 만들지 못한다. 유한한 애니메이션이 끝나고 문단 사각형이
 * 두 폴링 연속 같아질 때까지 기다린 뒤 좌표를 잰다.
 */
async function settleSheet(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(
    document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))
  ))
  await page.waitForFunction(() => {
    const el = document.querySelector('.paperpane .sheet p')
    if (!el) return false
    const r = el.getBoundingClientRect()
    const key = `${r.x},${r.y},${r.width},${r.height}`
    const w = window as unknown as { __sheetKey?: string; __sheetSame?: number }
    if (w.__sheetKey === key) w.__sheetSame = (w.__sheetSame ?? 0) + 1
    else { w.__sheetKey = key; w.__sheetSame = 0 }
    return (w.__sheetSame ?? 0) >= 2
  }, undefined, { polling: 'raf', timeout: 15_000 })
}

/**
 * 문단의 **첫 글자**와 그 뒤 글자의 화면 좌표 — 드래그 시작·끝점을 글자 위에 정확히 잡는다.
 * 여기서 만드는 것은 좌표뿐이다 — **선택은 아래 포인터 드래그가 만든다**(프로그램적 Range 로
 * 선택을 바꿔치기하지 않는다). 글꼴 대체·배율 차이로 "왼쪽에서 4px, 위에서 12px"이 글자 밖이
 * 되는 환경 차이를 없앤다.
 */
async function glyphPoints(page: Page): Promise<{ ax: number; ay: number; bx: number; by: number }> {
  return page.evaluate(() => {
    const p = document.querySelector('.paperpane .sheet p') as HTMLElement | null
    if (!p) throw new Error('문단을 찾지 못했다')
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    const node = walker.nextNode() as Text | null
    if (node && node.length > 8) {
      const r = document.createRange()
      r.setStart(node, 0); r.setEnd(node, Math.min(4, node.length))
      const a = r.getBoundingClientRect()
      r.setStart(node, Math.min(6, node.length)); r.setEnd(node, Math.min(16, node.length))
      const b = r.getBoundingClientRect()
      if (a.width > 0 && b.width > 0)
        return { ax: a.x + 1, ay: a.y + a.height / 2, bx: b.x + b.width - 1, by: b.y + b.height / 2 }
    }
    // 텍스트 노드를 못 집으면 문단 사각형의 **첫 줄 안쪽**으로 물러선다(줄 높이의 절반).
    const pr = p.getBoundingClientRect()
    const lh = parseFloat(getComputedStyle(p).lineHeight) || 24
    return { ax: pr.x + 4, ay: pr.y + lh / 2, bx: Math.min(pr.x + 140, pr.x + pr.width - 4), by: pr.y + lh / 2 }
  })
}

/**
 * 드래그 시작·끝 좌표를 잡되, **그 점이 정말 그 문단 위인지**를 `elementFromPoint` 로 확인한다.
 *
 * 좌표를 잰 뒤 마우스를 누르기까지 사이에 배치가 밀리면(맥 CI 처럼 빠른 기계에서 첫 레이아웃이
 * 아직 정착하지 않았을 때) 누름이 글자 밖에서 일어나 선택이 만들어지지 않는다. 그래서 재고 →
 * 확인 → 아니면 다시 재기를 반복한다. 20번 안에 못 맞추면 마지막 좌표로 진행하고, 아래
 * 선택 단언이 실패로 남는다(조용히 넘어가지 않는다).
 */
async function dragAnchors(page: Page): Promise<{ ax: number; ay: number; bx: number; by: number }> {
  let last: { ax: number; ay: number; bx: number; by: number } | null = null
  for (let i = 0; i < 20; i++) {
    const g = await glyphPoints(page)
    last = g
    const onText = await page.evaluate((pts) => {
      const p = document.querySelector('.paperpane .sheet p')
      if (!p) return false
      const a = document.elementFromPoint(pts.ax, pts.ay)
      const b = document.elementFromPoint(pts.bx, pts.by)
      return !!a && !!b && p.contains(a) && p.contains(b)
    }, g)
    if (onText) return g
    await page.waitForTimeout(50)
  }
  return last!
}

test('인용은 그 논문의 것 — 폴더를 바꾸면 지워지고 다른 논문으로 나가지 않는다 (QA2B-R1-01)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const a = synthProject()   // 600평
  const b = synthProject()   // 다른 논문
  const { electronApp, page } = await launch({ env })
  try {
    // 이 논문에도 본문이 있다 — 고를 문단이 그려진 뒤에 배치가 선다(MACR3-R1-02).
    await openProject(page, a, (p) => paperReady(p, '600평'))
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
    // 고를 문단이 준비된 뒤에 배치 안정을 본다 — 준비 전에 고르면 "문단을 찾지 못했다"로 깨진다(MACR3-R1-02).
    await openProject(page, root, (p) => paperReady(p, '600평'))
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

    // 배치가 멈춘 뒤에 좌표를 재고, 그 좌표로 **실제 마우스 드래그**를 한다(맥 CI 처방).
    // 글자 사각형은 좌표를 잡는 데만 쓴다 — 선택은 아래 포인터 이동이 만든다.
    await settleSheet(page)
    const g = await dragAnchors(page)
    await page.mouse.move(g.ax, g.ay)
    await page.mouse.down()
    await page.waitForTimeout(60)
    await page.mouse.move((g.ax + g.bx) / 2, g.ay, { steps: 6 })
    await page.waitForTimeout(60)
    await page.mouse.move(g.bx, g.by, { steps: 8 })
    await page.waitForTimeout(60)
    await page.mouse.up()

    // 정말 드래그로 골라졌는지부터 확인한다 — 안 골라졌으면 이 시험이 다른 것을 재게 된다.
    const picked = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    expect(picked.length, '드래그로 선택이 만들어지지 않았다').toBeGreaterThan(3)
    expect(picked, '드래그가 종이의 그 문장을 고르지 않았다').toContain('농장')

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
