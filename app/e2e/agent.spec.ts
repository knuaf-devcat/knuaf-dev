// Unit tests for src/main/agent.ts. Plain Playwright `test()` in Node: no Electron is launched.
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  agentApi, buildLaunchScript, codexSkillConfigOverride, findExecutable, firstPromptFor, installSkill, launch, probeVersion,
  skillBackupDir, skillSource, skillState, skillTargets, skillVersion, sq, VERSION_FILE
} from '../src/main/agent'
import { serverArgsFor } from '../src/main/chat/codex'

const appRoot = resolve(__dirname, '..')
const source = skillSource(appRoot, false, '/nonexistent')

// Where `claude` lives is machine-specific (Homebrew prefix, ~/.local/bin, a CI
// runner without it at all), so these assert the resolution behaviour rather than
// one developer's absolute path.
const claudePath = findExecutable('claude', process.env)

test.describe('findExecutable / probeVersion', () => {
  test('resolves an executable claude when installed, and null for a bogus name', async () => {
    if (claudePath) {
      expect(existsSync(claudePath)).toBe(true)
      expect(claudePath.endsWith('/claude') || claudePath.endsWith('\\claude.exe')).toBe(true)
    }
    expect(findExecutable('definitely-not-a-real-binary-xyz', process.env)).toBeNull()
  })

  test('falls back to the extra dirs when PATH is empty', () => {
    // Same answer without PATH: the fallback dirs must cover the usual installs.
    expect(findExecutable('claude', { PATH: '', HOME: process.env.HOME })).toBe(claudePath)
  })

  test('probeVersion returns a line for claude and null for a missing binary', async () => {
    test.skip(!claudePath, 'claude is not installed on this machine')
    const v = await probeVersion(claudePath!)
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

  test('a references-only change moves the version', () => {
    // It did not before: references/ was left out of the hash entirely, so replacing
    // every rule document still read as 'installed' and projects kept a stale copy.
    const fake = mkdtempSync(join(tmpdir(), 'kd-skill-refs-'))
    writeFileSync(join(fake, 'SKILL.md'), '# same\n')
    mkdirSync(join(fake, 'references'))
    writeFileSync(join(fake, 'references', 'workflow-order.md'), '원래 내용\n')
    const before = skillVersion(fake)
    writeFileSync(join(fake, 'references', 'workflow-order.md'), '바뀐 내용\n')
    expect(skillVersion(fake)).not.toBe(before)
  })

  test('a same-length script edit moves the version', () => {
    // The old hash used name:size, so an equal-length edit was invisible.
    const fake = mkdtempSync(join(tmpdir(), 'kd-skill-size-'))
    writeFileSync(join(fake, 'SKILL.md'), '# same\n')
    mkdirSync(join(fake, 'scripts'))
    writeFileSync(join(fake, 'scripts', 'gg_core.py'), 'VERSION = "1.0"\n')
    const before = skillVersion(fake)
    writeFileSync(join(fake, 'scripts', 'gg_core.py'), 'VERSION = "9.9"\n')
    expect(skillVersion(fake)).not.toBe(before)
  })

  test('bytecode and OS junk do not move the version', () => {
    // installSkill never copies these, so they must not make a project look outdated.
    const fake = mkdtempSync(join(tmpdir(), 'kd-skill-junk-'))
    writeFileSync(join(fake, 'SKILL.md'), '# same\n')
    mkdirSync(join(fake, 'scripts'))
    writeFileSync(join(fake, 'scripts', 'gg_core.py'), 'x = 1\n')
    const before = skillVersion(fake)
    mkdirSync(join(fake, 'scripts', '__pycache__'))
    writeFileSync(join(fake, 'scripts', '__pycache__', 'gg_core.cpython-313.pyc'), 'junk')
    writeFileSync(join(fake, 'scripts', '.DS_Store'), 'junk')
    expect(skillVersion(fake)).toBe(before)
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
    expect(existsSync(third.backup!)).toBe(true)
    expect(readFileSync(join(third.backup!, VERSION_FILE), 'utf-8')).toBe('tampered\n')
    expect(readFileSync(join(targets.claude, VERSION_FILE), 'utf-8').trim()).toBe(version)

    // The backup must not be a sibling of the skill: anything under skills/ is
    // discovered as its own skill, so a sibling backup competes with the real one.
    expect(readdirSync(join(root, '.claude', 'skills'))).toEqual(['knuaf-doc'])
    expect(third.backup).toBe(join(skillBackupDir(targets.claude), basename(third.backup!)))
    expect(basename(third.backup!)).toMatch(/^\.claude-\d{8}-\d{6}$/)
    expect(third.backup!.startsWith(join(root, '.knuaf-gui'))).toBe(true)
  })

  test('a codex backup is named apart from a claude one', () => {
    const root = mkdtempSync(join(tmpdir(), 'kd-root-bak-'))
    const targets = skillTargets(root)
    const version = skillVersion(source)
    for (const kind of ['claude', 'codex'] as const) {
      installSkill(source, targets[kind], version)
      writeFileSync(join(targets[kind], VERSION_FILE), 'tampered\n')
      installSkill(source, targets[kind], version)
    }
    const backups = readdirSync(join(root, '.knuaf-gui', 'skill-backups')).sort()
    expect(backups).toHaveLength(2)
    expect(backups.some((n) => n.startsWith('.claude-'))).toBe(true)
    expect(backups.some((n) => n.startsWith('.agents-'))).toBe(true)
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
    // ~/.claude/CLAUDE.md의 @import가 외부 경로를 가리키면 학생에게 영어 보안 프롬프트가 뜬다 —
    // 이 앱이 띄우는 도우미는 메모리 파일을 아예 읽지 않는다.
    expect(s).toContain('export CLAUDE_CODE_DISABLE_CLAUDE_MDS=1')
    expect(s).toContain('knuaf-doc 동반 앱이 AI 도우미를 엽니다')
    // 비상구(외부 터미널)에도 채팅과 같은 가드레일 — 프로젝트 스킬만 유효 + 도구 팝업 차단.
    // `--disallowedTools=…` 는 `=` 필수 — 공백이면 가변 인자가 첫 프롬프트를 삼킨다.
    expect(s).toContain(`exec '/opt/homebrew/bin/claude' --setting-sources project,local '--disallowedTools=AskUserQuestion' '시작하기'`)
  })

  test('codex gets no positional prompt and no -c without a global skill copy; sq escapes single quotes', () => {
    const s = buildLaunchScript({ root: '/x', agent: 'codex', agentPath: '/opt/homebrew/bin/codex', venvBin: null, bundledBin: null, firstPrompt: '시작하기' })
    expect(s.trimEnd().split('\n').pop()).toBe(`exec '/opt/homebrew/bin/codex'`)
    expect(s).not.toContain('skills.config')
    expect(s).not.toContain("'시작하기'")
    expect(sq(`it's`)).toBe(`'it'\\''s'`)
    expect(firstPromptFor(0)).toBe('시작하기')
    expect(firstPromptFor(null)).toBe('시작하기')
    expect(firstPromptFor(3)).toBe('이어서 하기')
  })

  test('a stale global knuaf-doc copy is disabled for the external codex launch', () => {
    // ~/.codex/skills·~/.agents/skills 의 낡은 사본이 프로젝트 사본과 함께 enabled 로
    // 보이면 모델이 옛 지침을 따른다 — 비상구 터미널에서도 그 사본을 끈다.
    const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
    expect(codexSkillConfigOverride(home)).toBeNull()
    mkdirSync(join(home, '.codex', 'skills', 'knuaf-doc'), { recursive: true })
    writeFileSync(join(home, '.codex', 'skills', 'knuaf-doc', 'SKILL.md'), '# old\n')
    const cfg = codexSkillConfigOverride(home)
    expect(cfg).toBe(`skills.config=[{path="${join(home, '.codex', 'skills', 'knuaf-doc', 'SKILL.md')}",enabled=false}]`)
    const s = buildLaunchScript({ root: '/x', agent: 'codex', agentPath: '/opt/codex', venvBin: null, bundledBin: null, firstPrompt: '', home })
    expect(s).toContain(`-c '${cfg}'`)

    // app-server 스폰에도 같은 오버라이드 — -c 는 subcommand 앞의 루트 인자다.
    expect(serverArgsFor({ HOME: home })).toEqual(['-c', cfg, 'app-server'])
    expect(serverArgsFor({ HOME: join(mkdtempSync(join(tmpdir(), 'kd-home-')), 'none') })).toEqual(['app-server'])
    // ~/.agents/skills 도 스캔 대상 — 두 사본이 함께 있으면 둘 다 끈다.
    mkdirSync(join(home, '.agents', 'skills', 'knuaf-doc'), { recursive: true })
    writeFileSync(join(home, '.agents', 'skills', 'knuaf-doc', 'SKILL.md'), '# old\n')
    expect(serverArgsFor({ HOME: home })[1]).toContain('.agents')
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
    expect(readFileSync(r.scriptPath, 'utf-8')).toContain(`exec '/opt/homebrew/bin/claude' --setting-sources project,local '--disallowedTools=AskUserQuestion' '시작하기'`)
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
    // Whether claude is installed is a property of the machine, not of agentApi.
    expect(st.claude).toMatchObject({ found: claudePath !== null, path: claudePath })
    if (claudePath) expect(typeof st.claude.version).toBe('string')
    expect(st.skill).toEqual({ claude: 'missing', codex: 'missing' })
    expect(st.skillVersion).toBe(skillVersion(source))

    expect(agentApi.installSkill(ctx, 'codex', root)).toEqual({ action: 'installed' })
    expect(existsSync(join(root, '.agents', 'skills', 'knuaf-doc', 'SKILL.md'))).toBe(true)
    expect((await agentApi.status(ctx, root)).skill).toEqual({ claude: 'missing', codex: 'installed' })

    // launch resolves the real binary, so it only runs where claude is installed.
    // buildLaunchScript is covered separately with a fixed path, so the script
    // contents stay asserted on every machine.
    if (claudePath) {
      const r = await agentApi.launch(ctx, { root: '/tmp/논문 폴더', kind: 'claude', revision: 2 })
      const script = readFileSync(r.scriptPath, 'utf-8')
      expect(script).toContain(`cd '/tmp/논문 폴더' || exit 1`)
      expect(script).toContain(`export PATH='/tmp/논문 폴더/.venv/bin':`)
      expect(script).toContain(`exec '${claudePath}' --setting-sources project,local '--disallowedTools=AskUserQuestion' '이어서 하기`)
      expect(script).toContain(`작업 폴더: /tmp/논문 폴더`)
      expect(opened).toEqual([])
    }
  })
})
