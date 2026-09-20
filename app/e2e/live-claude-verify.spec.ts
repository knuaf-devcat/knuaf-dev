// Personal-use verification, Claude path: real Claude Agent SDK chat.
// Covers: skill load → first interview question → Korean answer round-trip →
// agent_busy gate mid-run → app quit mid-run → relaunch restores interrupted →
// resume remembers earlier answers (600).
// Costs real subscription usage; run deliberately. KNUAF_LIVE=1 gated by the
// `live-*` filename pattern in playwright.config.
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import type { ChatSnapshot } from '../src/shared/chat'

test.setTimeout(600_000)

const snap = async (page: any, root: string): Promise<ChatSnapshot | null> => page.evaluate(async (rt) => {
  const x = await window.knuaf.chat.snapshot(rt, 'claude'); return 'result' in x ? x.result : null
}, root)
const send = async (page: any, root: string, text: string) => page.evaluate(async ([rt, t]) => {
  const x = await window.knuaf.chat.send(rt, 'claude', t, crypto.randomUUID()); return x
}, [root, text] as const)
const waitIdle = async (page: any, root: string, timeout = 300_000) => expect.poll(async () => {
  const s = await snap(page, root)
  if (s?.state === 'error') throw new Error(`도우미 오류: ${s.error}`)
  if (s?.state === 'permission') throw new Error(`권한 카드가 멈춰 있다: ${s.permission?.title}`)
  return s?.state
}, { timeout }).toBe('idle')

test('claude chat: skill load, interview, busy gate, quit+resume', async () => {
  const root = synthProject()
  const app1 = await launch({ env: { KNUAF_CLAUDE_MODEL: 'sonnet' } })
  const { electronApp, page } = app1
  try {
    await openProject(page, root)
    await page.waitForSelector('h1:has-text("내 논문")', { timeout: 30_000 })
    const st = await page.evaluate(async (r) => {
      const x = await window.knuaf.chat.status(r, 'claude'); return 'result' in x ? x.result : null
    }, root)
    console.log('status:', JSON.stringify(st))
    expect(st?.installed).toBe(true)
    expect(st?.connected).toBe(true)

    // 1) start the interview — the skill must load inside the real SDK session
    await send(page, root, '시작하기')
    await expect.poll(async () => (await snap(page, root))?.state, { timeout: 30_000 }).toBe('running')
    // busy gate: during a running turn, sidecar writes are refused
    const busy = await page.evaluate(async (r) => {
      const x = await window.knuaf.call('lock.unlock', { root: r }); return 'error' in x ? x.error : null
    }, root)
    console.log('write-gate:', JSON.stringify(busy))

    await waitIdle(page, root)
    const s1 = await snap(page, root)
    expect(s1!.skillLoaded).toBe(true)
    const q = s1!.messages.filter((m) => m.role === 'assistant').at(-1)!.text
    console.log('--- first question ---\n' + q.slice(-800))
    await page.screenshot({ path: 'e2e/artifacts/verify-claude-q1.png' })

    // 2) answer once; confirm delivery and snapshot file
    await send(page, root, '재배 면적은 600평이에요')
    await waitIdle(page, root)
    const s2 = await snap(page, root)
    const mine = s2!.messages.filter((m) => m.role === 'user').at(-1)!
    expect(mine.delivery).toBe('sent')
    expect(existsSync(join(root, '.knuaf-gui', 'chat-claude.json'))).toBe(true)
    await page.screenshot({ path: 'e2e/artifacts/verify-claude-a1.png' })

    // 3) simulate mid-run quit: start a turn and close the app while running
    await send(page, root, '머리말 초안을 이어서 작성해줘')
    await expect.poll(async () => (await snap(page, root))?.state, { timeout: 30_000 }).toBe('running')
  } finally {
    await electronApp.close()
  }

  // 4) relaunch: snapshot restored as interrupted + last user msg uncertain
  const app2 = await launch({ env: { KNUAF_CLAUDE_MODEL: 'sonnet' } })
  const { electronApp: app2e, page: page2 } = app2
  try {
    await openProject(page2, root)
    await expect.poll(async () => (await snap(page2, root))?.state, { timeout: 30_000 }).toBe('interrupted')
    const s3 = await snap(page2, root)
    const lastUser = s3!.messages.filter((m) => m.role === 'user').at(-1)!
    expect(lastUser.delivery).toBe('uncertain')
    // 같은 세션으로 이어진다 — 재개는 새 스레드가 아니라 sessionId 를 탄다.
    expect(s3!.sessionId).toBeTruthy()
    await page2.screenshot({ path: 'e2e/artifacts/verify-claude-interrupted.png' })

    // 5) resume must remember what was already answered — the value of 재개.
    await send(page2, root, '이어서 진행해 줘. 그리고 내가 아까 알려준 재배 면적이 몇 평인지 한 번만 확인해 줘')
    await waitIdle(page2, root)
    const s4 = await snap(page2, root)
    const lastAssistant = s4!.messages.filter((m) => m.role === 'assistant').at(-1)!.text
    console.log('--- resume tail ---\n' + lastAssistant.slice(-800))
    expect(lastAssistant).toContain('600')
    await page2.screenshot({ path: 'e2e/artifacts/verify-claude-resumed.png' })
  } finally {
    await app2e.close()
  }

  console.log('files:', existsSync(join(root, '00_interview_log.md')) ? 'interview log present' : 'no interview log yet')
  const p = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'))
  console.log('revision:', p.revision, '| facts:', Object.keys(p.facts ?? {}).length)
})
