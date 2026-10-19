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
    await expect(page.locator('.chat-thread')).toContainText('기존 대화')
    await composer.fill(body)
    await expect.poll(() => page.evaluate((r) => window.knuaf.chat.draft(r), root)).toEqual({ result: body })

    // 같은 폴더를 다시 읽되, 연결 상태 응답에서 멈춰 세운다.
    await holdChannel(electronApp, 'chat:status')
    await openProject(page, root, splitReady)
    await expect.poll(() => heldCount(electronApp)).toBeGreaterThan(0)
    await expect(composer, '재읽기 중에 입력칸이 살아 있어야 한다').toHaveValue(body)

    // 재읽기가 대기 중인데 그대로 보낸다 — 화면·디스크에 붙고 초안은 소비된다.
    await page.locator('.chat-composer button.send').click()
    await expect(page.locator('.chat-msg.user')).toContainText(body)
    await expect(composer).toHaveValue('')
    await expect.poll(() => diskUserTexts(root), { timeout: 30_000 }).toEqual([body])
    await expect.poll(() => page.evaluate((r) => window.knuaf.chat.draft(r), root)).toEqual({ result: '' })

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
    const opening = openProject(page, root, (p: Page) => paperReady(p, '600평')).then(() => { returned = true })
    await expect.poll(() => heldCount(electronApp)).toBeGreaterThan(0)
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })

    // 준비(절 목록) 전에는 헬퍼가 돌아오지 않는다 — 돌아왔다면 시험이 지금 재고 고를 수 있다.
    expect(returned, '절 목록이 오기 전에 헬퍼가 돌아왔다').toBe(false)
    expect(await page.locator('.paperpane .sheet p').count(), '준비 전인데 고를 문단이 있다').toBe(0)

    await releaseHeld(electronApp)
    await opening
    expect(returned, '절 목록이 왔는데도 헬퍼가 돌아오지 않았다').toBe(true)
    // 이제 준비됐다 — 바로 고를 수 있는 상태다.
    await expect(page.locator('.paperpane .sheet')).toContainText('600평')
    await expect(page.locator('.workspace.split')).toBeVisible()
  } finally {
    await electronApp.close()
  }
})