/**
 * 형님 확정 시안(2026-10-19, `retake-20261019/DECISION.md`) — 전송 중 A안 · 알림창 B안 · 스크롤바 B안.
 * 실제 Electron 앱으로 밟는다. 도우미는 가짜 `codex app-server`.
 */
import { expect, test } from '@playwright/test'
import { launch, openProject, PROGRESS, synthProject } from './helpers'
import { CHAT } from '../src/renderer/src/copy'
import { fakeCodexEnv, scratch, seedChat } from './fixtures/fake-codex'

const COMPOSER = `textarea[placeholder="${CHAT.placeholder}"]`
const at = (min: number): string => new Date(Date.now() - min * 60_000).toISOString()

async function sendFrom(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.locator(COMPOSER).fill(text)
  await page.locator('.chat-composer button.send').click()
}

test('보내는 중에는 말풍선 밖 글자 하나만, 멈추기는 남는다 (전송 중 A안)', async () => {
  const dir = scratch()
  const root = synthProject()
  // 과거 기록에 남은 pending — 그 말풍선에는 아무것도 붙지 않아야 한다(시안 검토 R2-01).
  seedChat(root, [
    { id: 'u-old', role: 'user', text: '예전에 멈춘 질문', at: at(10), delivery: 'pending' },
    { id: 'a-old', role: 'assistant', text: '예전 답', at: at(9) }
  ])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_HOLD: '1' }) })
  try {
    await openProject(page, root)
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(PROGRESS), '작업 전인데 진행 표시가 있다').toHaveCount(0)
    await sendFrom(page, '새로 보낸 질문')
    const sending = page.locator('.deliv[data-st="sending"]')
    await expect(sending).toHaveCount(1, { timeout: 30_000 })
    await expect(sending).toContainText(CHAT.sendingLine)
    await expect(page.locator('.zone-status'), '보내는 중인데 빙글이 줄도 돈다(진행 표시 2개)').toHaveCount(0)
    await expect(page.locator(PROGRESS)).toHaveCount(1)
    // 글자는 **마지막** 학생 말풍선 바로 뒤에만 — 예전 pending 말풍선 뒤에는 없다.
    await expect(page.locator('.chat-msg.user:has-text("새로 보낸 질문") + .deliv')).toHaveCount(1)
    await expect(page.locator('.chat-msg.user:has-text("예전에 멈춘 질문") + .deliv')).toHaveCount(0)
    // 말풍선 안 알약·단추는 없다.
    await expect(page.locator('.chat-msg.user .badge')).toHaveCount(0)
    await expect(page.locator('.chat-msg.user button')).toHaveCount(0)
    // 취소 수단은 남는다.
    await expect(page.locator('.chat-composer button.send')).toHaveAttribute('aria-label', CHAT.stop)
  } finally {
    await electronApp.close()
  }
})

test('답이 오기 시작하면 글자는 사라지고 빙글이 줄 하나만 (전송 중 A안)', async () => {
  const dir = scratch()
  const root = synthProject()
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_HOLD: 'after-delta' }) })
  try {
    await openProject(page, root)
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    await sendFrom(page, '질문')
    await expect(page.locator('.zone-status')).toContainText(CHAT.runningLine, { timeout: 30_000 })
    await expect(page.locator('.deliv[data-st="sending"]')).toHaveCount(0)
    await expect(page.locator(PROGRESS)).toHaveCount(1)
  } finally {
    await electronApp.close()
  }
})

test('보냈는지 확인 못 한 말풍선은 밖 아래 빨간 글자 + 다시 보내기 링크 (전송 중 A안)', async () => {
  const dir = scratch()
  const root = synthProject()
  seedChat(root, [{ id: 'u1', role: 'user', text: '끊긴 질문', at: at(1), delivery: 'uncertain' }], 'interrupted')
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    const unsure = page.locator('.chat-msg.user:has-text("끊긴 질문") + .deliv.bad')
    await expect(unsure).toContainText(CHAT.uncertainLine, { timeout: 30_000 })
    await expect(unsure.getByRole('button', { name: CHAT.resend })).toBeVisible()
    await expect(page.locator('.chat-msg.user .badge')).toHaveCount(0)
    // 중단 안내도 입력칸 위 한 줄이다 — 대화 맨 위 상자가 아니다(알림창 B안).
    await expect(page.locator('.chat-zone .zline')).toContainText(CHAT.interruptedTitle)
    await expect(page.locator('.chat-inner > .feedback')).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('대화 화면의 알림은 입력칸 위 옅은 회색 한 줄 — 붉은 바탕 없음, ✕ 로 닫힌다 (알림창 B안)', async () => {
  const dir = scratch()
  const root = synthProject()
  seedChat(root, [{ id: 'u1', role: 'user', text: '질문', at: at(2), delivery: 'sent' }])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    // 전송을 main 이 거절하게 한다 — 저장·검사 중 거절과 같은 길(IPC 오류 → 화면 오류).
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('chat:send')
      ipcMain.handle('chat:send', () => ({ error: { code: 'chat', message: '앱이 저장·검사 작업 중이에요. 끝난 뒤 답변을 보내 주세요.' } }))
    })
    await openProject(page, root)
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    await sendFrom(page, '다음 질문')
    const line = page.locator('.chat-zone .zline')
    await expect(line).toContainText(CHAT.appBusyTitle, { timeout: 30_000 })
    const colors = await line.first().evaluate((el) => {
      const probe = document.createElement('div')
      probe.style.background = 'var(--panel-2)'
      document.body.appendChild(probe)
      const want = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { got: getComputedStyle(el).backgroundColor, want }
    })
    expect(colors.got, '알림 바탕이 옅은 회색이 아니다').toBe(colors.want)
    await expect(page.locator('.feedback.error')).toHaveCount(0)
    await line.getByRole('button', { name: '닫기' }).click()
    await expect(line).toHaveCount(0)
    await expect(page.locator(COMPOSER), '쓴 글이 사라졌다').toHaveValue('다음 질문')
  } finally {
    await electronApp.close()
  }
})

test('스크롤 칸은 굴릴 때만 표시를 받고 1초 뒤 뗀다, 표준 스크롤바 속성은 auto 그대로 (스크롤바 B안)', async () => {
  const dir = scratch()
  const root = synthProject()
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, role: 'assistant', text: `긴 답 ${i}\n`.repeat(6), at: at(60 - i) }))
  seedChat(root, many)
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    const thread = page.locator('.chat-thread')
    await expect(thread).toBeVisible({ timeout: 30_000 })
    await expect(thread).not.toHaveAttribute('data-scrolling', /.*/)
    await thread.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    await expect(thread).toHaveAttribute('data-scrolling', '')
    await expect(thread).not.toHaveAttribute('data-scrolling', /.*/, { timeout: 3_000 })
    // 크로뮴 121+ 는 이 값이 auto 가 아니면 ::-webkit-scrollbar 를 무시한다 — 칸과 모든 상위가 auto 여야 한다.
    for (const sel of ['.chat-thread', '.desk']) {
      const bad = await page.evaluate((sel) => {
        const out: string[] = []
        for (let el = document.querySelector(sel); el; el = el.parentElement) {
          const cs = getComputedStyle(el)
          if (cs.scrollbarWidth !== 'auto' || cs.scrollbarColor !== 'auto') out.push(`${el.className}: ${cs.scrollbarWidth} / ${cs.scrollbarColor}`)
        }
        return out
      }, sel)
      expect(bad, `${sel} 위로 표준 스크롤바 속성이 auto 가 아니다`).toEqual([])
    }
  } finally {
    await electronApp.close()
  }
})

/** main 이 화면으로 보내는 대화 스냅샷을 시험에서 직접 보낸다(`chat:snapshot` 이벤트). */
async function push(electronApp: import('@playwright/test').ElectronApplication, snap: Record<string, unknown>): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, snap) => { BrowserWindow.getAllWindows()[0].webContents.send('chat:snapshot', snap) }, snap)
}

test('닫은 오류는 그 건만 숨는다 — 다음 턴의 같은 오류는 다시 보인다 (검토 RETAKE-UI-R1-01)', async () => {
  const dir = scratch()
  const root = synthProject()
  const u1 = { id: 'u1', role: 'user', text: '첫 질문', at: at(3), delivery: 'sent' }
  const u2 = { id: 'u2', role: 'user', text: '두 번째 질문', at: at(1), delivery: 'sent' }
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    const bad = page.locator('.chat-zone .zline.bad')
    await push(electronApp, { root, provider: 'codex', state: 'error', error: '연결 종료', messages: [u1] })
    await expect(bad).toBeVisible({ timeout: 10_000 })
    await bad.getByRole('button', { name: '닫기' }).click()
    await expect(bad).toHaveCount(0)
    // 같은 건이 다시 와도(재전송된 같은 스냅샷) 닫힌 채다.
    await push(electronApp, { root, provider: 'codex', state: 'error', error: '연결 종료', messages: [u1] })
    await expect(bad).toHaveCount(0)
    // 새 턴 → 같은 문구의 새 오류는 다시 보여야 한다.
    await push(electronApp, { root, provider: 'codex', state: 'running', messages: [u1, { ...u2, delivery: 'pending' }] })
    await expect(page.locator(PROGRESS)).toHaveCount(1)
    await push(electronApp, { root, provider: 'codex', state: 'error', error: '연결 종료', messages: [u1, u2] })
    await expect(bad, '앞서 닫은 문구라는 이유로 새 실패가 숨었다').toBeVisible({ timeout: 10_000 })
  } finally {
    await electronApp.close()
  }
})

test('중단·멈춤 안내도 ✕ 로 그 건만 닫힌다 (검토 RETAKE-UI-R1-02)', async () => {
  const dir = scratch()
  const root = synthProject()
  const u1 = { id: 'u1', role: 'user', text: '끊긴 질문', at: at(3), delivery: 'uncertain' }
  seedChat(root, [u1], 'interrupted')
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    const halt = page.locator('.chat-zone .zline.attn')
    await expect(halt).toContainText(CHAT.interruptedTitle, { timeout: 30_000 })
    await expect(halt.getByRole('button', { name: CHAT.resend })).toBeVisible()
    await halt.getByRole('button', { name: '닫기' }).click()
    await expect(halt).toHaveCount(0)
    // 새 턴을 멈추면 그 안내는 새 건이라 다시 보인다.
    await push(electronApp, { root, provider: 'codex', state: 'stopped', messages: [u1, { id: 'u2', role: 'user', text: '다시', at: at(1), delivery: 'uncertain' }] })
    await expect(halt).toContainText(CHAT.stoppedTitle, { timeout: 10_000 })
    await expect(halt.getByRole('button', { name: '닫기' })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})
