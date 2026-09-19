// Personal-use verification, Claude path: real `claude` CLI inside the embedded terminal.
// Covers: skill load → interview question appears → Korean answer round-trip → agent_busy gate
// while the agent writes → app quit mid-session → relaunch → --continue resume.
// Costs real subscription usage; run deliberately.
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'

test.setTimeout(600_000)

const settle = async (page: any, id: string, quietMs = 12_000, maxMs = 240_000) => {
  // Wait until the pty replay buffer stops growing for `quietMs` (turn ended / waiting for input).
  let last = '', stable = 0, waited = 0
  while (waited < maxMs) {
    const r = await page.evaluate(async (i) => {
      const x = await window.knuaf.term.replay(i); return 'result' in x ? x.result : ''
    }, id)
    if (r === last) { stable += 2000; if (stable >= quietMs) return r } else { stable = 0; last = r }
    await page.waitForTimeout(2000); waited += 2000
  }
  return last
}

const termId = async (page: any, root: string) => {
  const list = await page.evaluate(async (r) => {
    const x = await window.knuaf.term.list(r); return 'result' in x ? x.result : []
  }, root)
  return list.find((t: any) => t.kind === 'claude')?.id as string | undefined
}

test('claude terminal: skill load, interview, busy gate, quit+resume', async () => {
  const root = synthProject()
  const app1 = await launch({ env: { KNUAF_TERM_MODEL: 'sonnet' } })
  const { electronApp, page } = app1
  let id: string | undefined
  try {
    await openProject(page, root)
    await page.click('button[role="tab"]:has-text("Claude (터미널)")')
    await expect(page.locator('.term-host .xterm')).toBeVisible()
    await expect.poll(async () => await termId(page, root), { timeout: 20_000 }).toBeTruthy()
    id = await termId(page, root)

    // 1) skill loads inside the real CLI
    await expect.poll(async () => {
      const r = await page.evaluate(async (i) => {
        const x = await window.knuaf.term.replay(i); return 'result' in x ? x.result : ''
      }, id!)
      return r.includes('knuaf-doc')
    }, { timeout: 120_000 }).toBe(true)

    // 2) while the agent is producing output, sidecar writes are refused
    const busy = await page.evaluate(async (r) => {
      const x = await window.knuaf.call('lock.unlock', { root: r })
      return 'error' in x ? x.error : null
    }, root)
    console.log('write-gate during activity:', JSON.stringify(busy))

    // 3) wait for the first interview question (turn settles with the input box ready)
    const first = await settle(page, id!)
    await page.screenshot({ path: 'e2e/artifacts/verify-claude-q1.png' })
    console.log('--- turn 1 tail ---\n' + first.slice(-1200))

    // 4) answer in Korean via IME-safe typing
    await page.click('.term-host')
    await page.keyboard.type('재배 면적은 600평이에요')
    await page.keyboard.press('Enter')
    const second = await settle(page, id!)
    await page.screenshot({ path: 'e2e/artifacts/verify-claude-a1.png' })
    console.log('--- turn 2 tail ---\n' + second.slice(-1200))
    expect(second).toContain('600')
  } finally {
    await electronApp.close() // mid-session quit: pty gets SIGHUP
  }

  // 5) relaunch: the old pty is gone; a fresh terminal offers --continue
  const app2 = await launch({ env: { KNUAF_TERM_MODEL: 'sonnet' } })
  const { electronApp: app2e, page: page2 } = app2
  try {
    await openProject(page2, root)
    await page2.click('button[role="tab"]:has-text("Claude (터미널)")')
    await expect(page2.locator('.term-host .xterm')).toBeVisible()
    // new pty spawns with firstPrompt "이어서 하기" (revision >= 1)
    await expect.poll(async () => await termId(page2, root), { timeout: 20_000 }).toBeTruthy()
    const id2 = await termId(page2, root)
    expect(id2).not.toBe(id)
    const resumed = await settle(page2, id2!, 12_000, 180_000)
    await page2.screenshot({ path: 'e2e/artifacts/verify-claude-resume.png' })
    console.log('--- resume tail ---\n' + resumed.slice(-800))
  } finally {
    await app2e.close()
  }

  // 6) the skill contract files: whatever the agent recorded is on disk, GUI adds only .knuaf-gui
  console.log('project files:', existsSync(join(root, '00_interview_log.md')) ? 'interview log present' : 'no interview log yet',
    existsSync(join(root, '.knuaf-gui', 'terminal-claude.log')) ? '| terminal log present' : '')
  if (existsSync(join(root, 'project.json'))) {
    const p = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'))
    console.log('revision:', p.revision, '| facts:', Object.keys(p.facts ?? {}).length)
  }
})
