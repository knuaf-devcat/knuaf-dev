/**
 * 형님 맥 실사용 4건(2026-10-20) — 입력칸 스크롤바·멈추기 단추 비율·자동으로 따라 내려가기·맨 아래로 단추 자리.
 * 질문 카드(②)는 순수 함수라 `question.spec.ts` 에서 고정한다.
 */
import { expect, test } from '@playwright/test'
import { launch, openProject, synthProject } from './helpers'
import { CHAT } from '../src/renderer/src/copy'
import { fakeCodexEnv, scratch, seedChat } from './fixtures/fake-codex'

const COMPOSER = `textarea[aria-label="${CHAT.placeholder}"]`
const at = (min: number): string => new Date(Date.now() - min * 60_000).toISOString()
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, role: 'assistant', text: `긴 답 ${i}\n`.repeat(6), at: at(120 - i) }))

async function push(electronApp: import('@playwright/test').ElectronApplication, snap: Record<string, unknown>): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, snap) => { BrowserWindow.getAllWindows()[0].webContents.send('chat:snapshot', snap) }, snap)
}

/** 대화 칸 바닥과의 거리(px). 0 근처면 바닥에 붙어 있다. */
/** 바닥 여백(8px) 안이면 붙어 있는 것으로 본다 — 예전 방식(끝 표시 요소에 맞추기)은 그 여백만큼 남았다. */
const gap = (el: Element): number => el.scrollHeight - el.scrollTop - el.clientHeight

test('입력칸 안에 스크롤바가 서지 않는다 — 빈 칸도, 최대 높이를 넘은 긴 글도 (형님 2026-10-20 ①)', async () => {
  const dir = scratch()
  const root = synthProject()
  seedChat(root, many(2))
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    const ta = page.locator(COMPOSER)
    await expect(ta).toBeVisible({ timeout: 30_000 })
    const bar = (): Promise<number> => ta.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)
    expect(await bar(), '빈 입력칸에 스크롤바가 선다').toBe(0)
    await ta.fill('긴 초안\n'.repeat(30))
    expect(await ta.evaluate((el) => el.scrollHeight > el.clientHeight), '시험 전제: 최대 높이를 넘었다').toBe(true)
    expect(await bar(), '긴 글에 스크롤바가 선다').toBe(0)
    // 굴리기는 그대로다.
    await ta.evaluate((el) => { el.scrollTop = 0 })
    await ta.hover(); await page.mouse.wheel(0, 200)
    await expect.poll(() => ta.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  } finally {
    await electronApp.close()
  }
})

test('도우미 답이 같은 말풍선에서 자라도 바닥에 붙어 따라 내려간다 (형님 2026-10-20 ③)', async () => {
  const dir = scratch()
  const root = synthProject()
  const base = many(30)
  seedChat(root, base)
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    const thread = page.locator('.chat-thread')
    await expect(thread).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => thread.evaluate(gap)).toBeLessThan(12)
    const u = { id: 'u1', role: 'user', text: '다음', at: at(2), delivery: 'sent' }
    // 스트리밍: 같은 id 의 도우미 메시지 글이 늘어난다 — 메시지 수는 그대로다.
    for (let k = 1; k <= 4; k++) {
      await push(electronApp, { root, provider: 'codex', state: 'running', messages: [...base, u, { id: 'live', role: 'assistant', text: '자라는 답\n'.repeat(k * 8), at: at(1) }] })
      await expect.poll(() => thread.evaluate(gap), `${k}번째 조각 뒤 바닥에서 떨어졌다`).toBeLessThan(12)
    }
    // 턴이 끝나 아래 칸이 바뀌어도(작업 중 줄 → 입력칸) 바닥에 붙어 있다.
    await push(electronApp, { root, provider: 'codex', state: 'idle', messages: [...base, u, { id: 'live', role: 'assistant', text: '자라는 답\n'.repeat(40), at: at(1) }] })
    await expect.poll(() => thread.evaluate(gap)).toBeLessThan(12)
    await expect(page.locator('.to-bottom')).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('위를 읽는 중이면 끌어내리지 않고, 맨 아래로 단추가 입력칸 바로 위 가운데 원형으로 뜬다 (형님 2026-10-20 ③④)', async () => {
  const dir = scratch()
  const root = synthProject()
  const base = many(30)
  seedChat(root, base)
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    const thread = page.locator('.chat-thread')
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    await thread.evaluate((el) => { el.scrollTop = 0 })
    const btn = page.getByRole('button', { name: CHAT.toBottom })
    await expect(btn).toBeVisible()
    await push(electronApp, { root, provider: 'codex', state: 'idle', messages: [...base, { id: 'n1', role: 'assistant', text: '새 답\n'.repeat(10), at: at(1) }] })
    await expect.poll(() => thread.evaluate((el) => el.scrollTop), '읽는 중인 화면을 끌어내렸다').toBe(0)
    // 자리: 입력칸 바로 위, 대화 칸 가운데, 원형.
    const b = (await btn.boundingBox())!
    const c = (await page.locator('.chat-composer').boundingBox())!
    const t = (await thread.boundingBox())!
    expect(Math.abs(b.width - b.height), '원형이 아니다').toBeLessThan(1)
    expect(b.y + b.height, '입력칸 위가 아니다').toBeLessThanOrEqual(c.y)
    expect(c.y - (b.y + b.height), '입력칸에서 너무 멀다').toBeLessThan(48)
    expect(Math.abs(b.x + b.width / 2 - (t.x + t.width / 2)), '가운데가 아니다').toBeLessThan(2)
    expect(await btn.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%')
    await btn.click()
    await expect.poll(() => thread.evaluate(gap)).toBeLessThan(12)
    await expect(btn).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('멈추기 단추의 네모는 단추 지름의 1/3 이상이다 (형님 2026-10-20 ①)', async () => {
  const dir = scratch()
  const root = synthProject()
  seedChat(root, many(2))
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    await push(electronApp, { root, provider: 'codex', state: 'running', messages: [...many(2), { id: 'u1', role: 'user', text: '다음', at: at(1), delivery: 'sent' }] })
    const stop = page.getByRole('button', { name: CHAT.stop })
    await expect(stop).toBeVisible({ timeout: 10_000 })
    const outer = (await stop.boundingBox())!
    const square = (await stop.locator('rect').boundingBox())!
    expect(square.width / outer.width, `네모 ${square.width.toFixed(1)}px / 단추 ${outer.width}px`).toBeGreaterThanOrEqual(1 / 3)
  } finally {
    await electronApp.close()
  }
})
