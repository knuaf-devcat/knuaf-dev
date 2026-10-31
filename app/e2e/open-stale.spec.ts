/**
 * 폴더를 바꾼 뒤 **이전 열기의 늦은 단계**가 지금 폴더 화면에 끼어들지 않는다(검토 CI43-R1-01).
 *
 * 폴더 열기(`store/project.ts` open)는 sidecar `project.status` 를 기다린 뒤 대화를 한 번 더 읽는다.
 * 그 사이 학생이 사이드바에서 다른 폴더를 누르면, 예전에는 늦게 깨어난 이전 열기가 **이전 폴더로**
 * 대화를 읽기 시작해 지금 폴더의 대화·오류 줄을 비웠다. 화면은 곧 지금 폴더를 다시 읽지만, 그 틈에
 * 오류 줄의 닫기 단추가 DOM 에서 떨어져 학생의 한 번 누름이 사라졌다.
 *
 * 순서는 시험이 고정한다: 이전 열기의 `project.status` 응답만 보류하고, 다른 방문으로 옮긴 뒤 풀어 준다.
 * 그 뒤의 대화 조회는 보류해 두고, 이전 방문의 대화 읽기가 **시작되는지**와 그 사이 닫기 단추가 떨어지는지 본다.
 * 응답 값은 바꾸지 않는다 — 순서만 고정한다. 가짜 `codex app-server` 만 쓴다(실제 AI·네트워크 없음).
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { addSectionBody, launch, openProject, splitReady, synthProject } from './helpers'
import { fakeCodexEnv, scratch, seedChat } from './fixtures/fake-codex'

const msg = { id: 'stale-u1', role: 'user', text: '지금 폴더의 질문', at: new Date().toISOString(), delivery: 'sent' }

/** main 이 읽는 실제 대화 기록에 오류를 심는다(화면에만 밀어 넣는 값이 아니다). */
function seedError(root: string): void {
  seedChat(root, [msg], 'error')
  writeFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), JSON.stringify({ root, provider: 'codex', state: 'error', error: '연결 종료', messages: [msg] }))
}

type Probe = { held: boolean; snapshotRoots: string[]; peeks: string[] }
type Gate = Probe & { release: () => void; releaseChats: () => void }
const gateOf = (): Gate => (globalThis as unknown as { stale: Gate }).stale

/**
 * `target` 의 다음 `project.status` 응답을 보류한다. 풀어 준 뒤의 `chat:snapshot`·`chat:status` 응답은
 * `releaseChats` 까지 보류한다. `project:peek`(refresh 가 status 다음에 부른다)과 대화 조회는 기록만 한다.
 */
async function gate(app: ElectronApplication, target: string): Promise<void> {
  await app.evaluate(({ ipcMain }, target) => {
    type H = (...a: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, H> })._invokeHandlers
    const status = Promise.withResolvers<void>()
    const chats = Promise.withResolvers<void>()
    let holdChats = false
    const s = {
      held: false, snapshotRoots: [] as string[], peeks: [] as string[],
      release: () => { holdChats = true; status.resolve() },
      releaseChats: () => { holdChats = false; chats.resolve() }
    }
    ;(globalThis as unknown as { stale: typeof s }).stale = s
    const rpc = handlers.get('rpc')!
    handlers.set('rpc', async (...a: unknown[]) => {
      const out = await rpc(...a)
      const params = a[2] as { root?: string } | undefined
      if (!s.held && a[1] === 'project.status' && params?.root === target) { s.held = true; await status.promise }
      return out
    })
    const peek = handlers.get('project:peek')!
    handlers.set('project:peek', async (...a: unknown[]) => { const out = await peek(...a); s.peeks.push(String(a[1])); return out })
    for (const ch of ['chat:snapshot', 'chat:status']) {
      const orig = handlers.get(ch)!
      handlers.set(ch, async (...a: unknown[]) => {
        if (ch === 'chat:snapshot') s.snapshotRoots.push(String(a[1]))
        const out = await orig(...a)
        if (holdChats) await chats.promise
        return out
      })
    }
  }, target)
}
const probe = (app: ElectronApplication): Promise<Probe> =>
  app.evaluate(() => { const s = (globalThis as unknown as { stale: Probe }).stale; return { held: s.held, snapshotRoots: [...s.snapshotRoots], peeks: [...s.peeks] } })

/** 사이드바의 최근 논문 단추로 연다 — 학생이 실제로 누르는 길(`ProjectSidebar.tsx`). */
async function pickRecent(page: Page, root: string): Promise<void> {
  await page.locator('.project-entry button.project-nav').filter({ hasText: basename(root) }).click()
  await expect(page.locator('.project-nav.selected')).toHaveAttribute('title', root)
}

/**
 * 오류 줄의 닫기 단추를 누른 채로 보류한 `project.status` 를 풀고, 늦게 깨어난 열기가 할 일을 다 한 뒤에도
 * 단추가 붙어 있는지·이전 방문의 대화 읽기가 시작되지 않았는지 본다. 붙어 있으면 그 누름이 그대로 닫기가 된다.
 */
async function closeWhileStaleWakes(app: ElectronApplication, page: Page, target: string, why: string): Promise<void> {
  const bad = page.locator('.chat-zone .zline.bad')
  await expect(bad).toBeVisible({ timeout: 30_000 })
  const btn = bad.getByRole('button', { name: '닫기' })
  const handle = await btn.elementHandle()
  const box = (await btn.boundingBox())!
  const before = await probe(app)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await app.evaluate(() => { (globalThis as unknown as { stale: Gate }).stale.release() })
  // 늦은 refresh() 가 project:peek 응답을 받을 때까지 — 그 다음이 "이어서 할 일"(설정 읽기 → 대화 읽기)이다.
  await expect.poll(async () => (await probe(app)).peeks.slice(before.peeks.length).includes(target)).toBe(true)
  // 이어진 일이 보냈을 요청이 main 에 닿도록 같은 창에서 두 번 왕복하고(IPC 는 순서를 지킨다), 화면이 그려지게 둔다.
  await page.evaluate(async () => {
    await window.knuaf.getSettings()
    await window.knuaf.getSettings()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))
  })
  const staleReads = (await probe(app)).snapshotRoots.slice(before.snapshotRoots.length)
  const connected = await handle!.evaluate((e) => e.isConnected)
  await page.mouse.up()
  await app.evaluate(() => { (globalThis as unknown as { stale: Gate }).stale.releaseChats() })
  expect(staleReads, why).toEqual([])
  expect(connected, '누르는 사이 닫기 단추가 화면에서 떨어졌다').toBe(true)
  await expect(bad, '누른 닫기가 처리되지 않았다').toHaveCount(0)
}

test('A 열기가 늦어도 B 로 옮긴 뒤 B 의 오류 닫기가 사라지지 않는다 (검토 CI43-R1-01)', async () => {
  const a = synthProject(), b = synthProject()
  seedError(b)
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(scratch(), 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, b, splitReady)          // 최근 목록에 B 를 올린다
    await gate(electronApp, a)
    await openProject(page, a)                       // A 의 project.status 가 보류된다
    await expect.poll(async () => (await probe(electronApp)).held).toBe(true)
    await pickRecent(page, b)
    await splitReady(page)
    await closeWhileStaleWakes(electronApp, page, a, '떠난 폴더(A)의 대화를 읽기 시작했다')
  } finally {
    await electronApp.close()
  }
})

test('A→B→A: 같은 폴더로 돌아와도 이전 A 열기의 늦은 단계가 지금 방문에 끼어들지 않는다 (검토 CI43-R1-01)', async () => {
  const a = synthProject(), b = synthProject()
  seedError(a)
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(scratch(), 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, b, splitReady)
    await openProject(page, a, splitReady)          // 최근 목록에 A·B 를 올리고 지금은 A
    await pickRecent(page, b)
    await splitReady(page)
    await gate(electronApp, a)
    await pickRecent(page, a)                        // 첫 번째 돌아온 A 열기 — project.status 가 보류된다
    await expect.poll(async () => (await probe(electronApp)).held).toBe(true)
    await pickRecent(page, b)
    await pickRecent(page, a)                        // 두 번째 A 방문 — 이번 열기는 보류되지 않는다
    await splitReady(page)
    // 늦은 첫 열기도 같은 폴더(A)를 읽는다. 폴더 이름만 비교하면 이 읽기를 막지 못한다 — 열기 세대로 막는다.
    await closeWhileStaleWakes(electronApp, page, a, '이전 A 방문의 늦은 열기가 지금 A 방문에서 대화를 다시 읽었다')
  } finally {
    await electronApp.close()
  }
})

/**
 * 원하는 RPC 메서드의 **첫** 응답(지정한 폴더)만 보류한다. 응답 값은 바꾸지 않는다 — 순서만 고정한다.
 * `deps:ensure` 는 IPC 채널 자체를 보류한다. 실제 설치는 부르지 않고 `reply` 로 준 값을 돌려준다.
 */
async function holdFirst(app: ElectronApplication, target: string, method: string, reply?: unknown): Promise<void> {
  await app.evaluate(({ ipcMain }, { target, method, reply }) => {
    type H = (...a: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, H> })._invokeHandlers
    const gate = Promise.withResolvers<void>()
    const s = { held: false, release: () => gate.resolve() }
    ;(globalThis as unknown as { hold: typeof s }).hold = s
    if (method === 'deps:ensure') {
      handlers.set('deps:ensure', async (_e: unknown, root: unknown) => {
        if (!s.held && root === target) { s.held = true; await gate.promise }
        return reply
      })
      return
    }
    const rpc = handlers.get('rpc')!
    handlers.set('rpc', async (...a: unknown[]) => {
      const out = await rpc(...a)
      const params = a[2] as { root?: string } | undefined
      if (!s.held && a[1] === method && params?.root === target) { s.held = true; await gate.promise }
      return out
    })
  }, { target, method, reply })
}
const held = (app: ElectronApplication): Promise<boolean> => app.evaluate(() => (globalThis as unknown as { hold: { held: boolean } }).hold.held)
const releaseHold = (app: ElectronApplication): Promise<void> => app.evaluate(() => { (globalThis as unknown as { hold: { release: () => void } }).hold.release() })
/** 보류를 푼 뒤 늦은 응답이 화면에 반영될 틈 — 같은 창에서 IPC 두 번 왕복하고 두 프레임 그린다. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.knuaf.getSettings()
    await window.knuaf.getSettings()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))
  })
}

/**
 * 첫 A 방문의 절 목록 응답이 B 를 거쳐 돌아온 두 번째 A 방문에서 도착해도 지금 목록을 덮지 않는다
 * (검토 OPEN-STALE-R1-01). 덮이면 두 번째 방문의 status 는 이미 최신 개정이라 주기 감시가 복구하지 않는다.
 */
test('A→B→A: 첫 A 방문의 늦은 절 목록이 지금 A 방문의 최신 목록을 덮지 않는다 (검토 OPEN-STALE-R1-01)', async () => {
  const a = synthProject(), b = synthProject()
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(scratch(), 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, b, splitReady)
    await holdFirst(electronApp, a, 'project.sections')
    await openProject(page, a)                       // 첫 A 방문 — 절 목록(옛 제목 'Ⅰ. 머리말') 응답이 보류된다
    await expect.poll(() => held(electronApp)).toBe(true)
    await pickRecent(page, b)
    await splitReady(page)
    addSectionBody(a, { title: 'Ⅰ. 새 방문의 제목', body: '새 방문 본문', expected: 1 })   // 디스크의 A 를 개정 2로
    await pickRecent(page, a)
    await splitReady(page)
    const h2 = page.locator('#sec-sec-01 h2')
    await expect(h2).toContainText('새 방문의 제목', { timeout: 30_000 })
    await releaseHold(electronApp)
    await settle(page)
    await expect(h2, '첫 방문의 옛 절 목록이 지금 목록을 덮었다').toContainText('새 방문의 제목')
    await expect(h2).not.toContainText('머리말')
  } finally {
    await electronApp.close()
  }
})

/**
 * A 방문의 늦은 준비 확인(doctor) 응답 "준비 안 됨"이 B 의 준비 상태를 바꾸지 않는다(검토 OPEN-STALE-R1-02).
 * 바뀌면 B 의 "지금" 단계가 준비(1단계)로 내려간다(`useStage` 의 depsFailed).
 */
test('A→B: A 의 늦은 준비 확인 응답이 B 의 준비 상태를 바꾸지 않는다 (검토 OPEN-STALE-R1-02)', async () => {
  const a = synthProject(), b = synthProject()
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(scratch(), 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    // 준비 확인은 시험이 답한다: 첫 A 확인만 "준비 안 됨"을 보류해 두고, 나머지는 "준비됨". 설치는 부르지 않는다.
    await electronApp.evaluate(({ ipcMain }, target) => {
      type H = (...a: unknown[]) => unknown
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, H> })._invokeHandlers
      const gate = Promise.withResolvers<void>()
      const s = { held: false, release: () => gate.resolve() }
      ;(globalThis as unknown as { hold: typeof s }).hold = s
      const rpc = handlers.get('rpc')!
      handlers.set('rpc', async (...a: unknown[]) => {
        if (a[1] !== 'doctor.all') return rpc(...a)
        const params = a[2] as { root?: string } | undefined
        if (!s.held && params?.root === target) { s.held = true; await gate.promise; return { result: { deps: { ready: false } } } }
        return { result: { deps: { ready: true } } }
      })
      handlers.set('deps:ensure', async () => ({ result: { ok: true } }))
    }, a)
    await openProject(page, b, splitReady)
    await openProject(page, a)                       // A 의 준비 확인이 보류된다
    await expect.poll(() => held(electronApp)).toBe(true)
    await pickRecent(page, b)
    await splitReady(page)
    const now = page.locator('.titlebar .tbtn.now')
    await expect(now).not.toContainText('준비')     // B 는 준비됨 — 1단계가 아니다
    const before = await now.textContent()
    await releaseHold(electronApp)
    await settle(page)
    await expect(now, 'A 의 늦은 "준비 안 됨"이 B 의 단계를 준비로 내렸다').toHaveText(before ?? '')
    await expect(now).not.toContainText('준비')
    await expect(page.locator('.chat-zone')).not.toContainText('처음 쓸 준비')
  } finally {
    await electronApp.close()
  }
})

/**
 * 첫 A 방문의 준비(설치) 실패가 B 를 거쳐 돌아온 두 번째 A 방문의 오류 줄에 뜨지 않는다(검토 OPEN-STALE-R1-02).
 * 그 작업이 실제로 끝났으므로 준비 대기 수는 줄어야 한다 — 입력칸 위 "준비 중" 줄이 남지 않는다.
 */
test('A→B→A: 첫 A 방문의 늦은 준비 실패가 지금 방문의 오류 줄에 뜨지 않고, 준비 대기도 남지 않는다 (검토 OPEN-STALE-R1-02)', async () => {
  const a = synthProject(), b = synthProject()
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(scratch(), 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    // 첫 A 확인만 "준비 안 됨" → 설치 시작. 그 설치 응답(실패)을 보류한다. 나머지 확인은 "준비됨".
    await electronApp.evaluate(({ ipcMain }, target) => {
      type H = (...a: unknown[]) => unknown
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, H> })._invokeHandlers
      const gate = Promise.withResolvers<void>()
      const s = { held: false, firstDoctor: true, release: () => gate.resolve() }
      ;(globalThis as unknown as { hold: typeof s }).hold = s
      const rpc = handlers.get('rpc')!
      handlers.set('rpc', async (...a: unknown[]) => {
        if (a[1] !== 'doctor.all') return rpc(...a)
        const params = a[2] as { root?: string } | undefined
        if (s.firstDoctor && params?.root === target) { s.firstDoctor = false; return { result: { deps: { ready: false } } } }
        return { result: { deps: { ready: true } } }
      })
      handlers.set('deps:ensure', async (_e: unknown, root: unknown) => {
        if (!s.held && root === target) { s.held = true; await gate.promise }
        return { error: { code: 'internal', message: 'OLD_A1_PREP_FAILURE' } }
      })
    }, a)
    await openProject(page, b, splitReady)
    await openProject(page, a)                       // 첫 A 방문 — 설치가 보류된다
    await expect.poll(() => held(electronApp)).toBe(true)
    await pickRecent(page, b)
    await splitReady(page)
    await pickRecent(page, a)
    await splitReady(page)
    const zone = page.locator('.chat-zone')
    await expect(zone).not.toContainText('준비 중 문제가 생겼어요')
    await releaseHold(electronApp)
    await settle(page)
    await expect(zone, '첫 방문의 준비 실패가 지금 방문의 오류 줄에 떴다').not.toContainText('준비 중 문제가 생겼어요')
    // 끝난 설치의 대기 수는 줄었다 — 입력칸 위 준비 줄이 남지 않는다.
    await expect(zone.locator('.zline.wait')).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})
