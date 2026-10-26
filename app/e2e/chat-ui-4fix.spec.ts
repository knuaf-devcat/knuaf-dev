/**
 * 형님 맥 실사용 4건(2026-10-20) — 입력칸 스크롤바·멈추기 단추 비율·자동으로 따라 내려가기·맨 아래로 단추 자리.
 * 질문 카드(②)는 순수 함수라 `question.spec.ts` 에서 고정한다.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { launch, openProject, splitReady, synthProject } from './helpers'
import { CHAT } from '../src/renderer/src/copy'
import { fakeCodexEnv, scratch, seedChat } from './fixtures/fake-codex'

const COMPOSER = `textarea[aria-label="${CHAT.placeholder}"]`
const at = (min: number): string => new Date(Date.now() - min * 60_000).toISOString()
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, role: 'assistant', text: `긴 답 ${i}\n`.repeat(6), at: at(120 - i) }))

/**
 * main 이 보내는 대화 스냅샷을 시험이 직접 보낸다. main 의 ChatService 는 이 값을 모른다 — 그래서
 * 이 뒤에 화면이 `load()` 를 **새로 시작하면** main 의 값(디스크의 대화)으로 되돌아간다.
 *
 * 폴더 열기(`project.ts` open)는 `refresh()`(sidecar status + peek)를 기다린 **뒤에** `load()` 를
 * 한 번 더 부른다. 느린 러너에서 그 `load()` 가 push 뒤에 시작되면 push 가 지워진다 — run
 * 40305503765 macOS 의 135줄 시험이 그랬다(중단 단추가 보였다가 사라져 boundingBox 가 30초를 다 썼다).
 * 그래서 push 하는 시험은 `openProject(page, root, splitReady)` 로 연다: 두 칸 배치는 `refresh()` 뒤의
 * `loadSections()` 가 돌아와야 서므로, 그때는 그 `load()` 가 이미 시작됐다(진행 중이면 `snapMoved` 로
 * push 를 지키고, 끝났으면 덮을 것이 없다).
 */
async function push(electronApp: import('@playwright/test').ElectronApplication, snap: Record<string, unknown>): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, snap) => { BrowserWindow.getAllWindows()[0].webContents.send('chat:snapshot', snap) }, snap)
}

/** 대화 칸 바닥과의 거리(px). 0 근처면 바닥에 붙어 있다. */
/** 바닥 여백(8px) 안이면 붙어 있는 것으로 본다 — 예전 방식(끝 표시 요소에 맞추기)은 그 여백만큼 남았다. */
const gap = (el: Element): number => el.scrollHeight - el.scrollTop - el.clientHeight

/**
 * 바닥에서 위로 끝까지 굴려 '맨 아래로' 단추가 뜨게 한다 — 학생이 바닥에서 위로 굴리는 동작 그대로다.
 *
 * 앱은 '위를 읽는 중'을 굴림 이벤트의 이동 방향(`top < lastTop - 1`)으로 판정하고(`Chat.tsx`
 * onThreadScroll), 그때만 단추를 그린다(`!atBottom`). 그래서 이 자극은 (1) 바닥으로 내려 앱이 그
 * 자리를 보게 하고, (2) 맨 위로 올린 뒤 **바닥을 다시 쓰지 않고** 단추를 기다린다. 앱이 굴림을 늦게
 * 보는 기계에서는 (2)의 값이 앱에 닿기 전에 바닥으로 되붙이면 방향이 통째로 사라진다 — 윈도 러너가
 * 그랬고(run 40299562503: 5초 안에 두 번 돌고 단추는 끝내 안 떴다), 회차마다 3초를 주고 되풀이한다.
 *
 * 한때 '두 프레임을 기다리기'로 같은 것을 하려 했는데, 숨은 창에서는 `requestAnimationFrame` 이
 * 1초에 한 번꼴(윈도 실측 두 번에 1.9초)로만 돌아 대기가 예산을 다 먹었다. 프레임을 세지 않는다.
 *
 * 되풀이하는 것은 **자극**(굴리기)이지 단언이 아니다. 단언은 부르는 쪽에 그대로 있다.
 */
async function scrollUpFromBottom(page: Page, thread: Locator): Promise<Locator> {
  const btn = page.getByRole('button', { name: CHAT.toBottom })
  await expect.poll(() => thread.evaluate((el) => el.scrollHeight - el.clientHeight),
    '답이 다 그려지기 전에 굴렸다 — 대화 칸이 아직 넘치지 않는다').toBeGreaterThan(100)
  for (let attempt = 1; attempt <= 4; attempt++) {
    // (1) 바닥으로 — 첫 회차에는 이미 바닥이라 아무 일도 일어나지 않는다.
    await thread.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect.poll(() => thread.evaluate(gap), '바닥으로 내리지 못했다').toBeLessThan(12)
    // (2) 맨 위로. 여기서부터는 **바닥을 다시 쓰지 않고** 단추를 기다린다 — 숨은 창에서는 앱이 굴림을
    //     1초에 한 번꼴로 보므로, 곧바로 바닥으로 되붙이면 위로 굴린 값이 앱에 닿기 전에 지워진다
    //     (run 40299562503 윈도 레그: 5초 안에 두 번 돌고 단추는 끝내 안 떴다).
    await thread.evaluate((el) => { el.scrollTop = 0 })
    if (await btn.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) return btn
  }
  await expect(btn, '맨 아래로 단추가 뜨지 않는다').toBeVisible()
  return btn
}

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
    await openProject(page, root, splitReady)   // push 가 열기 뒤 load() 에 지워지지 않게 — push() 주석
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
    await openProject(page, root, splitReady)   // push 가 열기 뒤 load() 에 지워지지 않게 — push() 주석
    const thread = page.locator('.chat-thread')
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    // 위를 읽는 중 — 바닥에서 위로 굴린다. 앱이 그 굴림을 볼 때까지 기다리는 까닭은 helper 주석에.
    const btn = await scrollUpFromBottom(page, thread)
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
    await openProject(page, root, splitReady)   // push 가 열기 뒤 load() 에 지워지지 않게 — push() 주석
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
