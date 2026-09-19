// Unit tests for src/main/terminal.ts driven through the KNUAF_TERM_SHELL shim (/bin/sh instead of
// a real agent). Plain Playwright `test()` in Node: node-pty is an N-API module, so the same
// prebuilt binary loads under both the test runner's Node and Electron — no Electron launch needed.
import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TerminalService, agentArgs } from '../src/main/terminal'
import { skillSource } from '../src/main/agent'

const appRoot = resolve(__dirname, '..')
const source = skillSource(appRoot, false, '/nonexistent')

test('a /bin/sh terminal echoes, replays, resizes, logs ANSI-free, installs the skill and exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-term-'))
  const events: { channel: string; payload: { id: string; data?: string; exitCode?: number } }[] = []
  const svc = new TerminalService({
    skillSource: source,
    emit: (channel, payload) => events.push({ channel, payload: payload as { id: string } }),
    venvPython: () => null,
    bundledPython: () => null,
    env: { ...process.env, KNUAF_TERM_SHELL: '/bin/sh' }
  })
  try {
    const info = svc.open(root, 'claude', { revision: null, cols: 80, rows: 24 })
    expect(info.alive).toBe(true)
    expect(info.pid).toBeTruthy()
    // opening the same root+kind twice returns the live session, not a second pty
    expect(svc.open(root, 'claude', { revision: null, cols: 80, rows: 24 }).id).toBe(info.id)

    svc.write(info.id, 'echo knuaf-ok\n')
    await expect.poll(() => events.filter((e) => e.channel === 'term:data').map((e) => e.payload.data ?? '').join('')).toContain('knuaf-ok')
    // output just arrived → the project is considered agent-active
    expect(svc.activeWithin(root, 5000)).toBe(true)

    svc.resize(info.id, 100, 30)
    expect(svc.replay(info.id)).toContain('knuaf-ok')
    expect(svc.list(root).map((t) => t.id)).toContain(info.id)

    svc.kill(info.id)
    await expect.poll(() => events.some((e) => e.channel === 'term:exit' && e.payload.id === info.id)).toBe(true)
    // no live sessions → activity no longer counts even though output was recent
    expect(svc.activeWithin(root, 5000)).toBe(false)

    const log = readFileSync(join(root, '.knuaf-gui', 'terminal-claude.log'), 'utf-8')
    expect(log).toContain('knuaf-ok')
    expect(log).not.toMatch(/\u001b/) // control bytes are stripped before they reach the log
    expect(existsSync(join(root, '.claude', 'skills', 'knuaf-doc', 'SKILL.md'))).toBe(true)
  } finally {
    svc.closeAll()
  }
})

// The composed argv had no committed coverage: the shell shim used by the test
// above short-circuits to an empty arg list, so these assert it directly.
test.describe('agentArgs', () => {
  test('claude gets the project setting scope, no AskUserQuestion, and a first prompt', () => {
    expect(agentArgs('claude', { revision: null })).toEqual([
      '--setting-sources', 'project,local',
      '--disallowedTools', 'AskUserQuestion',
      '시작하기'
    ])
  })

  test('an opened project resumes instead of sending a first prompt', () => {
    const args = agentArgs('claude', { revision: 3, resume: true })
    expect(args).toContain('--continue')
    expect(args).not.toContain('시작하기')
    expect(args).not.toContain('이어서 하기')
  })

  test('a revision with no resume asks to continue the existing work', () => {
    expect(agentArgs('claude', { revision: 3 })).toContain('이어서 하기')
  })

  test('--model is only added when one is pinned', () => {
    expect(agentArgs('claude', { revision: null })).not.toContain('--model')
    const args = agentArgs('claude', { revision: null, model: 'sonnet' })
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'sonnet'])
  })

  test('codex takes no flags, and the shell shim takes none either', () => {
    expect(agentArgs('codex', { revision: null })).toEqual([])
    expect(agentArgs('codex', { revision: null, model: 'sonnet' })).toEqual([])
    expect(agentArgs('claude', { revision: null, shell: true })).toEqual([])
  })
})
