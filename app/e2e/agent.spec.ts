// Unit tests for src/main/agent.ts. Plain Playwright `test()` in Node: no Electron is launched.
import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  agentApi, buildLaunchScript, findExecutable, firstPromptFor, installSkill, launch, probeVersion,
  skillSource, skillState, skillTargets, skillVersion, sq, VERSION_FILE
} from '../src/main/agent'

const appRoot = resolve(__dirname, '..')
const source = skillSource(appRoot, false, '/nonexistent')

test.describe('findExecutable / probeVersion', () => {
  test('finds claude on this Mac and null for a bogus name', async () => {
    const p = findExecutable('claude', process.env)
    expect(p).toBe('/opt/homebrew/bin/claude')
    expect(findExecutable('definitely-not-a-real-binary-xyz', process.env)).toBeNull()
  })

  test('falls back to the extra dirs when PATH is empty', () => {
    expect(findExecutable('claude', { PATH: '', HOME: process.env.HOME })).toBe('/opt/homebrew/bin/claude')
  })

  test('probeVersion returns a line for claude and null for a missing binary', async () => {
    const v = await probeVersion('/opt/homebrew/bin/claude')
    expect(typeof v).toBe('string')
    expect(v!.length).toBeGreaterThan(0)
    expect(v).not.toContain('\n')
    expect(await probeVersion('/nonexistent/bin/nothing')).toBeNull()
  })
})

test.describe('skill source + version', () => {
  test('skillSource resolves the checkout and packaged layouts', () => {
    expect(source).toBe(resolve(appRoot, '..', 'skills', 'knuaf-doc'))
    expect(existsSync(join(source, 'SKILL.md'))).toBe(true)
    expect(skillSource(appRoot, true, '/App/Contents/Resources')).toBe('/App/Contents/Resources/skill')
  })

  test('skillVersion is stable, 12 hex, and changes with content', () => {
    const a = skillVersion(source)
    const b = skillVersion(source)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)

    const fake = mkdtempSync(join(tmpdir(), 'kd-skill-'))
    writeFileSync(join(fake, 'SKILL.md'), '# x\n')
    const v1 = skillVersion(fake)
    writeFileSync(join(fake, 'SKILL.md'), '# y\n')
    expect(skillVersion(fake)).not.toBe(v1)
  })
})

test.describe('installSkill', () => {
  test('installs into a tmp project root, is unchanged on rerun, and backs up when tampered', () => {
    const root = mkdtempSync(join(tmpdir(), 'kd-root-'))
    const targets = skillTargets(root)
    expect(targets.claude).toBe(join(root, '.claude', 'skills', 'knuaf-doc'))
    expect(targets.codex).toBe(join(root, '.agents', 'skills', 'knuaf-doc'))
    const version = skillVersion(source)

    expect(skillState(targets.claude, version)).toBe('missing')
    const first = installSkill(source, targets.claude, version)
    expect(first).toEqual({ action: 'installed' })
    for (const f of ['SKILL.md', 'references', 'scripts', VERSION_FILE]) expect(existsSync(join(targets.claude, f))).toBe(true)
    expect(readFileSync(join(targets.claude, VERSION_FILE), 'utf-8').trim()).toBe(version)
    expect(skillState(targets.claude, version)).toBe('installed')
    // filtered copy: no __pycache__ even though the checkout has one
    expect(existsSync(join(targets.claude, 'scripts', '__pycache__'))).toBe(false)
    expect(readdirSync(join(targets.claude, 'scripts')).some((n) => n.endsWith('.py'))).toBe(true)
    // only the three parts + marker, never anything else
    expect(readdirSync(targets.claude).sort()).toEqual(['.knuaf-doc-version', 'SKILL.md', 'references', 'scripts'])

    expect(installSkill(source, targets.claude, version)).toEqual({ action: 'unchanged' })

    writeFileSync(join(targets.claude, VERSION_FILE), 'tampered\n')
    expect(skillState(targets.claude, version)).toBe('outdated')
    const third = installSkill(source, targets.claude, version)
    expect(third.action).toBe('updated')
    expect(third.backup).toMatch(/knuaf-doc\.bak-\d{8}-\d{6}$/)
    expect(existsSync(third.backup!)).toBe(true)
    expect(readFileSync(join(third.backup!, VERSION_FILE), 'utf-8')).toBe('tampered\n')
    expect(readFileSync(join(targets.claude, VERSION_FILE), 'utf-8').trim()).toBe(version)
    // sibling skills untouched
    expect(readdirSync(join(root, '.claude', 'skills')).sort()).toEqual([`knuaf-doc`, `knuaf-doc.bak-${third.backup!.split('.bak-')[1]}`].sort())
  })
})

test.describe('buildLaunchScript', () => {
  test('quotes paths and prompts, exports PATH, execs claude with the prompt', () => {
    const s = buildLaunchScript({
      root: '/tmp/논문 폴더', agent: 'claude', agentPath: '/opt/homebrew/bin/claude',
      venvBin: '/tmp/논문 폴더/.venv/bin', bundledBin: '/App/Resources/python/bin', firstPrompt: '시작하기'
    })
    expect(s.startsWith('#!/bin/bash\n')).toBe(true)
    expect(s).toContain(`cd '/tmp/논문 폴더' || exit 1`)
    expect(s).toContain(`export PATH='/tmp/논문 폴더/.venv/bin':'/App/Resources/python/bin':'/opt/homebrew/bin':'/usr/local/bin':"$HOME/.local/bin":"$PATH"`)
    expect(s).toContain('export KNUAF_DOC_APP=1')
    expect(s).toContain('knuaf-doc 동반 앱이 AI 도우미를 엽니다')
    expect(s).toContain(`exec '/opt/homebrew/bin/claude' '시작하기'`)
  })

  test('codex gets no positional prompt; sq escapes single quotes', () => {
    const s = buildLaunchScript({ root: '/x', agent: 'codex', agentPath: '/opt/homebrew/bin/codex', venvBin: null, bundledBin: null, firstPrompt: '시작하기' })
    expect(s.trimEnd().split('\n').pop()).toBe(`exec '/opt/homebrew/bin/codex'`)
    expect(s).not.toContain("'시작하기'")
    expect(sq(`it's`)).toBe(`'it'\\''s'`)
    expect(firstPromptFor(0)).toBe('시작하기')
    expect(firstPromptFor(null)).toBe('시작하기')
    expect(firstPromptFor(3)).toBe('이어서 하기')
  })
})

test.describe('launch', () => {
  test('dryRun writes an executable .command and never calls open', async () => {
    const supportDir = join(mkdtempSync(join(tmpdir(), 'kd-support-')), 'nested')
    let opened = 0
    const r = await launch({
      root: '/tmp/p', agent: 'claude', agentPath: '/opt/homebrew/bin/claude', venvBin: null, bundledBin: null,
      firstPrompt: '시작하기', supportDir, dryRun: true
    }, { open: async () => { opened++; return '' } })
    expect(r.scriptPath.startsWith(supportDir)).toBe(true)
    expect(r.scriptPath).toMatch(/launch-[0-9a-f]{8}\.command$/)
    expect(statSync(r.scriptPath).mode & 0o111).toBeTruthy()
    expect(readFileSync(r.scriptPath, 'utf-8')).toContain(`exec '/opt/homebrew/bin/claude' '시작하기'`)
    expect(opened).toBe(0)
  })

  test('calls open when not dryRun and surfaces its error', async () => {
    const supportDir = mkdtempSync(join(tmpdir(), 'kd-support-'))
    const calls: string[] = []
    const r = await launch({ root: '/tmp/p', agent: 'codex', agentPath: '/x/codex', venvBin: null, bundledBin: null, firstPrompt: '', supportDir }, { open: async (p) => { calls.push(p); return '' } })
    expect(calls).toEqual([r.scriptPath])
    await expect(launch({ root: '/tmp/p', agent: 'codex', agentPath: '/x/codex', venvBin: null, bundledBin: null, firstPrompt: '', supportDir }, { open: async () => 'no app' })).rejects.toThrow('no app')
  })
})

test.describe('agentApi', () => {
  test('status + installSkill + launch compose against a tmp ctx', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kd-ctx-'))
    const opened: string[] = []
    const ctx = {
      home, appRoot, isPackaged: false, resourcesPath: '/nonexistent', supportDir: join(home, 'support'), dryRun: true,
      open: async (p: string) => { opened.push(p); return '' },
      venvPython: (root: string | null) => (root ? join(root, '.venv', 'bin', 'python3') : null),
      env: process.env
    }
    const root = mkdtempSync(join(tmpdir(), 'kd-root-'))
    // no project open: skill state reports missing for both agents
    expect((await agentApi.status(ctx, null)).skill).toEqual({ claude: 'missing', codex: 'missing' })
    const st = await agentApi.status(ctx, root)
    expect(st.claude).toMatchObject({ found: true, path: '/opt/homebrew/bin/claude' })
    expect(typeof st.claude.version).toBe('string')
    expect(st.skill).toEqual({ claude: 'missing', codex: 'missing' })
    expect(st.skillVersion).toBe(skillVersion(source))

    expect(agentApi.installSkill(ctx, 'codex', root)).toEqual({ action: 'installed' })
    expect(existsSync(join(root, '.agents', 'skills', 'knuaf-doc', 'SKILL.md'))).toBe(true)
    expect((await agentApi.status(ctx, root)).skill).toEqual({ claude: 'missing', codex: 'installed' })

    const r = await agentApi.launch(ctx, { root: '/tmp/논문 폴더', kind: 'claude', revision: 2 })
    const script = readFileSync(r.scriptPath, 'utf-8')
    expect(script).toContain(`cd '/tmp/논문 폴더' || exit 1`)
    expect(script).toContain(`export PATH='/tmp/논문 폴더/.venv/bin':`)
    expect(script).toContain(`exec '/opt/homebrew/bin/claude' '이어서 하기'`)
    expect(opened).toEqual([])
  })
})
