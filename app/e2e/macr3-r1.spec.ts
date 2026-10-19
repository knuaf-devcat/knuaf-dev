/**
 * MACR3-R1 처분 고정 시험 [2026-10-19]
 *
 * 검토 `impl/REVIEW-ASTRA-MACR3-R1.md`(FAIL: 차단 1·중요 1)의 두 탐침 순서를 그대로 옮겼다.
 *
 * 1) R1-01 — 같은 폴더를 다시 읽는 동안(=`chat:status` 응답을 붙잡아 둔 동안) 보낸 메시지가
 *    늦게 도착한 그 읽기의 옛 값으로 되돌아가지 않아야 한다. 화면에서 사라지거나, 보내 비운
 *    초안이 미전송 글처럼 되살아나면 학생이 같은 요청을 두 번 보낸다.
 * 2) R1-02 — `openProject` 의 배치 대기는 **호출자가 쓸 요소가 준비된 뒤**에 확인해야 한다.
 *    절 목록(`project.sections`)이 아직 오지 않았는데 헬퍼가 돌아오면, 그 뒤 배치가 두 칸으로
 *    바뀌며 시험이 재 둔 좌표·누를 자리가 낡는다.
 *
 * 두 시험 모두 제품 코드를 건드리지 않는다 — 응답 보류는 **시험 프로세스의 ipcMain** 에서만 한다.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, paperReady, splitReady, synthProject } from './helpers'
import { fakeCodexEnv, scratch, seedChat } from './fixtures/fake-codex'
import { CHAT } from '../src/renderer/src/copy'

const COMPOSER = `textarea[placeholder="${CHAT.placeholder}"]`

/**
 * 앱이 **일을 하는** 것을 기다리는 대기 — 윈도우 러너는 한 걸음이 기본 5초를 넘긴다(실측:
 * 윈도우 app 잡 28.9분 vs 맥 9.5분, 아래 시험의 기본 5초 poll 이 그렇게 걸렸다).
 * 값이 아니라 기다림만 늘린다 — 재는 것은 그대로다.
 */
const APP_WORK = 30_000

type Held = { __held?: (() => void)[] }

/**
 * 그 채널의 응답을 붙잡아 둔다(제품 코드·다른 통신은 그대로). 시험 전용 장치.
 * `only` 를 주면 `args[at] === is` 인 요청만 잡는다(예: `rpc` 채널의 `project.sections` 하나).
 */
async function holdChannel(
  app: ElectronApplication,
  channel: string,
  only?: { at: number; is: string }
): Promise<void> {
  await app.evaluate(({ ipcMain }, { ch, one }) => {
    const g = globalThis as unknown as Held
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers
    const handler = map.get(ch)
    if (!handler) throw new Error(`${ch} 핸들러를 찾지 못했다`)
    g.__held = []
    ipcMain.removeHandler(ch)
    ipcMain.handle(ch, async (...args: unknown[]) => {
      if (one && args[one.at] !== one.is) return handler(...args)
      const value = await handler(...args)
      return new Promise((resolve) => g.__held!.push(() => resolve(value)))
    })
  }, { ch: channel, one: only ?? null })
}

const heldCount = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() => ((globalThis as unknown as Held).__held ?? []).length)

async function releaseHeld(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const g = globalThis as unknown as Held
    g.__held?.splice(0).forEach((resolve) => resolve())
  })
}

const diskUserTexts = (root: string): string[] =>
  (JSON.parse(readFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), 'utf-8')) as {
    messages: { role: string; text: string }[]
  }).messages.filter((m) => m.role === 'user').map((m) => m.text)

test('재읽기가 보류된 동안 보낸 메시지는 늦은 응답에 되돌아가지 않는다 (MACR3-R1-01)', async () => {
  const root = synthProject()
  seedChat(root, [{ id: 'old', role: 'assistant', text: '기존 대화', at: '2026-10-19T00:00:00Z' }])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(scratch(), 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
  const composer = page.locator(COMPOSER)
  const body = '재읽는 동안 보낸 요청 MACR3'
  try {
    await openProject(page, root, splitReady)
    await expect(page.locator('.chat-thread'), '대화 기록이 그려지지 않았다').toContainText('기존 대화', { timeout: APP_WORK })
    await composer.fill(body)
    await expect.poll(() => page.evaluate((r) => window.knuaf.chat.draft(r), root), { timeout: APP_WORK }).toEqual({ result: body })

    // 같은 폴더를 다시 읽되, 연결 상태 응답에서 멈춰 세운다.
    await holdChannel(electronApp, 'chat:status')
    await openProject(page, root, splitReady)
    // 붙잡힌 요청이 **나타나기를** 기다린다 — 앱이 연결 상태를 확인하는 것은 폴더를 열고 나서다.
    await expect.poll(() => heldCount(electronApp), { timeout: APP_WORK, message: '재읽기의 상태 확인 요청이 붙잡히지 않았다' }).toBeGreaterThan(0)
    await expect(composer, '재읽기 중에 입력칸이 살아 있어야 한다').toHaveValue(body)

    // 재읽기가 대기 중인데 그대로 보낸다 — 화면·디스크에 붙고 초안은 소비된다.
    await page.locator('.chat-composer button.send').click()
    // 도우미 턴이 돌아 화면 스냅샷이 갱신되기까지(가짜 CLI 실행) — 앱이 일하는 자리다.
    await expect(page.locator('.chat-msg.user'), '보낸 글이 화면에 붙지 않았다').toContainText(body, { timeout: APP_WORK })
    await expect(composer).toHaveValue('')
    await expect.poll(() => diskUserTexts(root), { timeout: APP_WORK }).toEqual([body])
    await expect.poll(() => page.evaluate((r) => window.knuaf.chat.draft(r), root), { timeout: APP_WORK }).toEqual({ result: '' })

    // 보류를 풀면 늦은 읽기 응답이 도착한다. 그 뒤에도 화면과 초안이 **새 상태**여야 한다.
    await releaseHeld(electronApp)
    await expect.poll(() => heldCount(electronApp)).toBe(0)
    // 응답이 적용될 시간을 준 뒤 한 번만 판정한다(재시도로 덮지 않는다 — 수정 전에는 여기서 되돌아간다).
    await page.waitForTimeout(2000)
    await expect(page.locator('.chat-msg.user'), '늦은 읽기가 보낸 글을 화면에서 지웠다').toHaveCount(1)
    await expect(page.locator('.chat-msg.user')).toContainText(body)
    await expect(composer, '늦은 읽기가 소비한 초안을 되살렸다').toHaveValue('')
    expect(diskUserTexts(root), '디스크의 전송 기록이 사라졌다').toEqual([body])
  } finally {
    await electronApp.close()
  }
})

test('절 목록이 늦어도 헬퍼는 준비 전에 돌아오지 않는다 (MACR3-R1-02)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(scratch(), 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    // 절 목록 응답만 붙잡아 둔다 — 그동안 배치는 빈 한 칸(solo·폭 1180)으로 조용하다.
    await holdChannel(electronApp, 'rpc', { at: 1, is: 'project.sections' })
    let returned = false
    let openError: unknown = null
    /**
     * **이 약속은 늘 처리한다.** 시험이 먼저 실패하면 `finally` 가 앱을 닫으면서 떠 있던 이
     * 약속이 "Target page, context or browser has been closed" 로 거부되는데, 그 늦은 오류가
     * 첫 실패(예: 붙잡힌 요청이 안 나타남)를 덮어 진짜 원인을 가린다 — 윈도우 CI 에서 실제로
     * 그렇게 보고됐다(윈도우 trace). 실패는 시험이 낸 그대로 남긴다.
     */
    const opening = openProject(page, root, (p: Page) => paperReady(p, '600평'))
      .then(() => { returned = true }, (e: unknown) => { openError = e })
    // 앱이 절 목록을 요청하기까지 — 폴더를 열고 사이드카를 띄우는 첫 걸음이다.
    await expect.poll(() => heldCount(electronApp), {
      timeout: APP_WORK,
      message: '절 목록 요청이 붙잡히지 않았다 — 앱이 아직 절 목록을 요청하지 않았다'
    }).toBeGreaterThan(0)
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: APP_WORK })

    // 준비(절 목록) 전에는 헬퍼가 돌아오지 않는다 — 돌아왔다면 시험이 지금 재고 고를 수 있다.
    expect(returned, '절 목록이 오기 전에 헬퍼가 돌아왔다').toBe(false)
    expect(await page.locator('.paperpane .sheet p').count(), '준비 전인데 고를 문단이 있다').toBe(0)

    await releaseHeld(electronApp)
    await opening
    expect(openError, `헬퍼가 실패했다: ${String(openError)}`).toBeNull()
    expect(returned, '절 목록이 왔는데도 헬퍼가 돌아오지 않았다').toBe(true)
    // 이제 준비됐다 — 바로 고를 수 있는 상태다.
    await expect(page.locator('.paperpane .sheet')).toContainText('600평', { timeout: APP_WORK })
    await expect(page.locator('.workspace.split')).toBeVisible({ timeout: APP_WORK })
  } finally {
    await electronApp.close()
  }
})