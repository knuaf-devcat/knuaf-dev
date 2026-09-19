// Electron e2e for the "내 논문" screen: project opens on the chat tab, the Claude segment mounts
// an embedded terminal, and typing into xterm round-trips through the main-process pty.
// KNUAF_TERM_SHELL=/bin/sh makes TerminalService spawn a bare shell instead of the real claude CLI.
// xterm 6 paints on canvas (no DOM text), so the echoed output is asserted through the session's
// replay buffer — the exact same bytes the canvas displays — plus a screenshot artifact.
import { expect, test } from '@playwright/test'
import { launch, openProject, synthProject } from './helpers'

test('내 논문 opens on chat, the Claude terminal echoes input through the pty', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch({ env: { KNUAF_TERM_SHELL: '/bin/sh' } })
  try {
    await openProject(page, root)
    // projects now land on "내 논문" (chat) by default
    await expect(page.locator('.chat-seg')).toBeVisible()
    await expect(page.locator('.chat-composer textarea')).toBeVisible()

    await page.click('button[role="tab"]:has-text("Claude (터미널)")')
    await expect(page.locator('.term-host .xterm')).toBeVisible()

    // find the pty session through the renderer bridge, then type into xterm
    await expect.poll(async () => {
      const list = await page.evaluate(async (r) => {
        const r_ = await window.knuaf.term.list(r)
        return 'result' in r_ ? r_.result : []
      }, root)
      return list.filter((t) => t.kind === 'claude' && t.alive).map((t) => t.id)
    }).toHaveLength(1)

    await page.click('.term-host')
    await page.keyboard.type('echo knuaf-ok')
    await page.keyboard.press('Enter')

    // canvas has no DOM text; the replay buffer is the same output the canvas paints
    await expect.poll(async () => {
      const list = await page.evaluate(async (r) => {
        const r_ = await window.knuaf.term.list(r)
        return 'result' in r_ ? r_.result : []
      }, root)
      const id = list.find((t) => t.kind === 'claude')?.id
      if (!id) return ''
      const replay = await page.evaluate(async (i) => {
        const r_ = await window.knuaf.term.replay(i)
        return 'result' in r_ ? r_.result : ''
      }, id)
      return replay
    }).toContain('knuaf-ok')

    await page.screenshot({ path: 'e2e/artifacts/chat-terminal.png' })
  } finally {
    await electronApp.close()
  }
})
