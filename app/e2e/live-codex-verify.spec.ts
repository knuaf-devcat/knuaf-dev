// Personal-use verification, Codex path: real `codex app-server` structured chat.
// Covers: connection → skill check → first interview question → answer round-trip →
// agent_busy gate mid-run → app quit mid-run → relaunch restores interrupted/uncertain → resume.
// Requires ChatGPT login on this machine; quota resets ~14:00 KST.
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'

test.setTimeout(600_000)

const snap = async (page: any, root: string) => {
  const r = await page.evaluate(async (rt) => {
    const x = await window.knuaf.chat.snapshot(rt, 'codex'); return 'result' in x ? x.result : null
  }, root)
  return r
}
const send = async (page: any, root: string, text: string) => page.evaluate(async ([rt, t]) => {
  const x = await window.knuaf.chat.send(rt, 'codex', t, crypto.randomUUID()); return x
}, [root, text] as const)

test('codex chat: interview, busy gate, quit+resume', async () => {
  const root = synthProject()
  const app1 = await launch()
  const { electronApp, page } = app1
  try {
    await openProject(page, root)
    await page.waitForSelector('h1:has-text("내 논문")', { timeout: 30_000 })
    const st = await page.evaluate(async (r) => {
      const x = await window.knuaf.chat.status(r, 'codex'); return 'result' in x ? x.result : null
    }, root)
    console.log('status:', JSON.stringify(st))
    expect(st?.installed).toBe(true)
    expect(st?.connected).toBe(true)

    // 1) start the interview
    await send(page, root, '시작하기')
    await expect.poll(async () => (await snap(page, root))?.state, { timeout: 30_000 }).toBe('running')
    // busy gate: during a running turn, sidecar writes are refused
    const busy = await page.evaluate(async (r) => {
      const x = await window.knuaf.call('lock.unlock', { root: r }); return 'error' in x ? x.error : null
    }, root)
    console.log('write-gate:', JSON.stringify(busy))

    await expect.poll(async () => {
      const s = await snap(page, root)
      return s && s.state === 'idle' && s.messages.filter((m) => m.role === 'assistant').length
    }, { timeout: 300_000 }).toBeTruthy()
    const s1 = await snap(page, root)
    const q = s1!.messages.filter((m) => m.role === 'assistant').at(-1)!.text
    console.log('--- first question ---\n' + q.slice(-800))
    await page.screenshot({ path: 'e2e/artifacts/verify-codex-q1.png' })

    // 2) answer once; confirm delivery and snapshot file
    await send(page, root, '재배 면적은 600평이에요')
    await expect.poll(async () => (await snap(page, root))?.state, { timeout: 300_000 }).toBe('idle')
    const s2 = await snap(page, root)
    const mine = s2!.messages.filter((m) => m.role === 'user').at(-1)!
    expect(mine.delivery).toBe('sent')
    expect(existsSync(join(root, '.knuaf-gui', 'chat-codex.json'))).toBe(true)
    await page.screenshot({ path: 'e2e/artifacts/verify-codex-a1.png' })

    // 3) simulate mid-run quit: start a turn and close the app while running
    await send(page, root, '머리말 초안을 이어서 작성해줘')
    await expect.poll(async () => (await snap(page, root))?.state, { timeout: 30_000 }).toBe('running')
  } finally {
    await electronApp.close()
  }

  // 4) relaunch: snapshot restored as interrupted + last user msg uncertain
  const app2 = await launch()
  const { electronApp: app2e, page: page2 } = app2
  try {
    await openProject(page2, root)
    await expect.poll(async () => (await snap(page2, root))?.state, { timeout: 30_000 }).toBe('interrupted')
    const s3 = await snap(page2, root)
    const lastUser = s3!.messages.filter((m) => m.role === 'user').at(-1)!
    expect(lastUser.delivery).toBe('uncertain')
    await page2.screenshot({ path: 'e2e/artifacts/verify-codex-interrupted.png' })

    // 5) explicit resume: resend the uncertain answer
    await send(page2, root, lastUser.text)
    await expect.poll(async () => (await snap(page2, root))?.state, { timeout: 300_000 }).toBe('idle')
    const s4 = await snap(page2, root)
    expect(s4!.messages.filter((m) => m.role === 'user').at(-1)!.delivery).toBe('sent')
    await page2.screenshot({ path: 'e2e/artifacts/verify-codex-resumed.png' })
  } finally {
    await app2e.close()
  }

  console.log('files:', existsSync(join(root, '00_interview_log.md')) ? 'interview log present' : 'no interview log yet')
  const p = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'))
  console.log('revision:', p.revision, '| facts:', Object.keys(p.facts ?? {}).length)
})
