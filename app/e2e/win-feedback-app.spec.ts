/**
 * 형님 윈도우 실기 피드백(2026-10-19) — 실제 Electron 앱으로 밟는 장면.
 *
 * 새 논문(정본 tasks 에는 한글 마무리뿐 — 도우미가 기다리는 질문 0건)에서 도우미가 정본 형식을
 * 조금 벗어난 질문(굵은 글씨·윈도우 줄바꿈)을 보내도 질문 카드가 뜨고, 대화 본문에 별표가 남지 않는다.
 * 예전에는 `questionProject()` 처럼 user_owned 작업을 손으로 넣어야만 카드가 떴다.
 */
import { expect, test } from '@playwright/test'
import { launch, openProject, synthProject } from './helpers'
import { QUESTION_1, fakeCodexEnv, questionMessage, scratch, seedChat } from './fixtures/fake-codex'

const BOLD_CRLF = QUESTION_1
  .replace('[Q3-2] Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요', '**[Q3-2] Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요**')
  .replace(/\n/g, '\r\n')

test('새 논문에서도 질문 카드가 뜨고, 굵은 글씨는 별표 없이 보인다 (형님 윈도우 실기)', async () => {
  const dir = scratch()
  const root = synthProject()            // user_owned 작업 없음 — 새 논문의 실제 상태
  seedChat(root, [questionMessage('a-q1', BOLD_CRLF)])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    await expect(page.locator('.qcard'), '기다리는 질문 0건이라 카드가 안 떴다').toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.qcard .qcard-q')).toHaveText('지금 블루베리를 주로 어디에 팔고 있나요?')
    const body = page.locator('.chat-msg.assistant .prose').first()
    await expect(body.locator('strong')).toHaveText('[Q3-2] Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요')
    await expect(body, '별표가 글자로 남았다').not.toContainText('**')
  } finally {
    await electronApp.close()
  }
})

/**
 * 준비(deps.ensure)를 끝나지 않게 붙잡는다 — main 의 IPC 처리기를 시험 안에서만 바꾼다(검토 WINFB-R1 재현 방식).
 * `notReady` 폴더만 준비가 필요하다고 답하고, `__finishPrep()` 이 준비를 끝낸다. 보낸 글은 `__sent` 에 모인다.
 */
async function holdPrep(electronApp: import('@playwright/test').ElectronApplication, notReady: string): Promise<void> {
  await electronApp.evaluate(({ ipcMain }, notReady) => {
    const g = globalThis as unknown as Record<string, unknown>
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers
    const rpc = handlers.get('rpc')!
    ipcMain.removeHandler('rpc')
    ipcMain.handle('rpc', (e, method: string, params: { root?: string }, id: string) =>
      method === 'doctor.all' ? { result: { deps: { ready: params.root !== notReady } } } : rpc(e, method, params, id))
    ipcMain.removeHandler('deps:ensure')
    ipcMain.handle('deps:ensure', () => new Promise((resolve) => { g.__finishPrep = () => resolve({ result: { ok: true } }) }))
    g.__sent = []
    ipcMain.removeHandler('chat:send')
    ipcMain.handle('chat:send', (_e, root: string, _p: string, text: string) => {
      (g.__sent as string[]).push(text)
      return { result: { root, provider: 'codex', state: 'idle', messages: [] } }
    })
  }, notReady)
}

test('질문 카드에서 고른 답이 준비를 기다리면 이유를 보이고, 끝나면 한 번 간다 (검토 WINFB-R1-03)', async () => {
  const dir = scratch()
  const root = synthProject()
  seedChat(root, [questionMessage()])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await holdPrep(electronApp, root)
    await openProject(page, root)
    await expect(page.locator('.qcard')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => electronApp.evaluate(() => !!(globalThis as unknown as Record<string, unknown>).__finishPrep), { timeout: 30_000 }).toBe(true)
    await page.locator('.qopt').nth(0).click()
    await expect(page.getByRole('status'), '기다리는 이유가 안 보인다').toContainText('준비가 끝나면 바로 보낼게요')
    expect(await electronApp.evaluate(() => (globalThis as unknown as Record<string, unknown>).__sent)).toEqual([])
    await electronApp.evaluate(() => { ((globalThis as unknown as Record<string, unknown>).__finishPrep as () => void)() })
    await expect.poll(() => electronApp.evaluate(() => ((globalThis as unknown as Record<string, unknown>).__sent as string[]).length), { timeout: 30_000 }).toBe(1)
    await expect(page.locator('.zone-status:has-text("처음 쓸 준비")')).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('A 의 준비를 기다리는 중에 B 를 열면 B 는 잠기지 않고, 굵은 파일 링크도 눌린다 (검토 WINFB-R1-01·02)', async () => {
  const dir = scratch()
  const a = synthProject()
  const b = synthProject()
  seedChat(b, [questionMessage('links', '결과: [일반 문서](build/review.docx) 및 **[굵은 문서](build/review.docx)**')])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await holdPrep(electronApp, a)
    await openProject(page, a)
    const ta = page.locator('.chat-composer textarea')
    await expect(ta).toBeVisible({ timeout: 30_000 })
    await ta.fill('A 의 준비가 끝나면 보낼 답')
    // 준비 중에는 보내기가 잠긴다(알림창 B안). 첫 마디 단추는 기다렸다 보내는 길이다.
    await expect(page.locator('.chat-composer button.send')).toBeDisabled()
    await page.locator('.chat-empty button.primary').click()
    await expect(page.getByRole('status')).toContainText('준비가 끝나면 바로 보낼게요')
    await openProject(page, b)
    await expect(page.locator('.chat-msg.assistant')).toContainText('굵은 문서', { timeout: 30_000 })
    await page.locator('.chat-composer textarea').fill('B 에서 보낼 답')
    await expect(page.locator('.chat-composer button.send'), 'B 가 A 의 대기에 잠겼다').toBeEnabled()
    await expect(page.getByRole('status')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '굵은 문서', exact: true }), '굵은 파일 링크가 글자로 남았다').toBeVisible()
    await expect(page.getByRole('button', { name: '일반 문서', exact: true })).toBeVisible()
    await electronApp.evaluate(() => { ((globalThis as unknown as Record<string, unknown>).__finishPrep as () => void)() })
    await page.waitForTimeout(500)
    expect(await electronApp.evaluate(() => (globalThis as unknown as Record<string, unknown>).__sent), 'A 를 떠난 뒤 옛 요청이 나갔다').toEqual([])
  } finally {
    await electronApp.close()
  }
})
