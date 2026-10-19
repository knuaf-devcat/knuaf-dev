// Unit tests for src/main/agent.ts. Plain Playwright `test()` in Node: no Electron is launched.
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  agentApi, buildLaunchScript, bundledAgentDirs, bundledDirs, codexSkillConfigOverride, findExecutable, firstPromptFor, installSkill, launch, launchScriptExt, probeVersion,
  setAgentPlatformForTest, setBundledDirsProvider, skillBackupDir, skillSource, skillState, skillTargets, skillVersion, sq, VERSION_FILE
} from '../src/main/agent'
import { serverArgsFor } from '../src/main/chat/codex'
import { ChatService } from '../src/main/chat/service'

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
      if (process.platform === 'win32') {
        // 윈도우는 `claude`·`claude.cmd`·`claude.exe` 를 허용한다(확장자 없는 이름도 실행물이 된다).
        expect(['claude', 'claude.cmd', 'claude.exe']).toContain(basename(claudePath))
      } else {
        // 비 Windows 는 종전과 같다 — 이름이 정확히 `claude` 로 끝나야 한다.
        expect(claudePath.endsWith('/claude')).toBe(true)
      }
    }
    expect(findExecutable('definitely-not-a-real-binary-xyz', process.env)).toBeNull()
  })

  test('falls back to the extra dirs when PATH is empty', () => {
    // Same answer without PATH: the fallback dirs must cover the usual installs.
    expect(findExecutable('claude', { PATH: '', HOME: process.env.HOME })).toBe(claudePath)
  })

  /**
   * 검토 W1D-R1-02 — 복사된 환경(`AgentCtx.env`·시험 입력)은 일반 객체라 윈도우의 실제 키
   * `Path` 를 쓴다. 같은 원인으로 도구를 못 찾으면 안 된다. 맥은 `Path` 가 별개 변수다.
   */
  test('복사된 환경에서도 PATH 를 찾는다 — 윈도우는 키 이름을 대소문자 무시로 (W1D-R1-02)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kd-env-'))
    const win = process.platform === 'win32'
    const file = join(dir, win ? 'knuaf-probe-tool.cmd' : 'knuaf-probe-tool')
    writeFileSync(file, win ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', 'utf-8')
    if (!win) chmodSync(file, 0o755)
    if (win) {
      // 윈도우에서 실제 키는 `Path` 다 — 복사본에서도 찾아야 한다.
      expect(findExecutable('knuaf-probe-tool', { Path: dir, USERPROFILE: dir })).toBe(file)
      expect(findExecutable('knuaf-probe-tool', { PATH: dir, USERPROFILE: dir })).toBe(file)
    } else {
      // 맥에서는 `Path` 와 `PATH` 가 서로 다른 변수다 — `Path` 만으로는 찾지 않는다(맥 판정 불변).
      expect(findExecutable('knuaf-probe-tool', { Path: dir, HOME: dir })).toBeNull()
      expect(findExecutable('knuaf-probe-tool', { PATH: dir, HOME: dir })).toBe(file)
    }
  })

  /**
   * CODEX-BUNDLE — 윈도우 설치본에 동봉한 Codex CLI 는 PATH **앞**에서 찾는다. 호스트가 맥이어도
   * `platform: 'win32'` 로 윈도우 분기를 그대로 검사한다(파일 존재 검사는 호스트 것이므로
   * 실행 비트를 준다 — 윈도우에서는 확장자만 본다).
   */
  test('동봉한 CLI 를 PATH 앞에서 찾는다 — 윈도우 분기', () => {
    const bundled = mkdtempSync(join(tmpdir(), 'kd-bundle-'))
    const onPath = mkdtempSync(join(tmpdir(), 'kd-onpath-'))
    const bundledExe = join(bundled, 'codex.exe')
    const onPathExe = join(onPath, 'codex.exe')
    for (const f of [bundledExe, onPathExe]) { writeFileSync(f, ''); chmodSync(f, 0o755) }
    const found = findExecutable('codex', { Path: onPath, USERPROFILE: bundled }, { platform: 'win32', leadingDirs: [bundled] })
    expect(found).toBe(bundledExe)  // PATH 에도 있는데 동봉본이 이긴다
  })

  test('KNUAF_AGENT_PATH_ONLY=1 이면 동봉본도 보지 않는다 — "도구 없음" 화면의 의미 보존', () => {
    const bundled = mkdtempSync(join(tmpdir(), 'kd-only-'))
    const exe = join(bundled, 'codex.exe')
    writeFileSync(exe, '')
    chmodSync(exe, 0o755)
    expect(findExecutable('codex', { Path: '', USERPROFILE: bundled, KNUAF_AGENT_PATH_ONLY: '1' }, { platform: 'win32', leadingDirs: [bundled] })).toBeNull()
    // 같은 조건에서 스위치만 빼면 찾는다 — 위가 "없어서" 통과한 것이 아님을 같은 자리에서 보인다.
    expect(findExecutable('codex', { Path: '', USERPROFILE: bundled }, { platform: 'win32', leadingDirs: [bundled] })).toBe(exe)
  })

  test('맥 분기에서는 이름 규칙이 그대로다 — `.exe` 를 후보로 보지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kd-darwin-'))
    // 이름을 하나만 둔다(개발 기계의 진짜 codex 가 뒤 후보에서 걸리지 않게).
    const name = 'knuaf-bundle-probe'
    const exe = join(dir, `${name}.exe`)
    const plain = join(dir, name)
    writeFileSync(exe, '')
    chmodSync(exe, 0o755)
    expect(findExecutable(name, { PATH: '', HOME: dir }, { platform: 'darwin', leadingDirs: [dir] })).toBeNull()
    writeFileSync(plain, '')
    chmodSync(plain, 0o755)
    expect(findExecutable(name, { PATH: '', HOME: dir }, { platform: 'darwin', leadingDirs: [dir] })).toBe(plain)
  })

  test('bundledAgentDirs — 윈도우에서만, 패키지·개발 트리 각각의 자리', () => {
    const dev = { appRoot: '/tmp/app-root', isPackaged: false, resourcesPath: '/nonexistent' }
    expect(bundledAgentDirs(dev, 'darwin')).toEqual([])
    expect(bundledAgentDirs(dev, 'win32')).toEqual([join('/tmp/app-root', 'resources', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin')])
    expect(bundledAgentDirs({ ...dev, isPackaged: true, resourcesPath: '/app/Contents/Resources' }, 'win32'))
      .toEqual([join('/app/Contents/Resources', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin')])
  })

  /**
   * 검토 CODEX-BUNDLE-R1-01 — 동봉 우선은 **옵션을 준 호출자만의 혜택이면 안 된다**. 첫 화면
   * (`connect:status`)과 로그인·채팅(`ChatService`)은 `findExecutable(provider)` 를 옵션 없이
   * 부르기 때문이다. 그래서 동봉 자리는 `findExecutable` 의 **기본값**이고, 그 기본값을 여기서
   * (그리고 아래 ChatService 시험에서) 확인한다.
   */
  test.describe('동봉 우선은 기본값 (CODEX-BUNDLE-R1-01)', () => {
    /**
     * `ChatService` 는 탐색을 `findExecutable(provider)` 로 부른다 — env 인자가 없어 **process.env**
     * 를 본다(연결 객체에 넘기는 env 는 spawn 환경이라 다른 것이다). 그래서 실제 소비 경로를
     * 검사하려면 process.env 를 잠시 바꿔야 한다. 끝나면 되돌린다.
     */
    const withBundled = (dir: string, fn: () => void | Promise<void>, envPatch: Record<string, string> = {}) => {
      const prevPlatform = setAgentPlatformForTest('win32')
      const prevDirs = setBundledDirsProvider(() => [dir])
      const prevEnv = new Map<string, string | undefined>()
      const patch: Record<string, string> = { Path: '', PATH: '', HOME: dir, USERPROFILE: dir, ...envPatch }
      return (async () => {
        try {
          for (const [k, v] of Object.entries(patch)) { prevEnv.set(k, process.env[k]); process.env[k] = v }
          await fn()
        } finally {
          for (const [k, v] of prevEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
          setAgentPlatformForTest(prevPlatform)
          setBundledDirsProvider(prevDirs)
        }
      })()
    }
    const fakeExe = (dir: string, name = 'codex.exe'): string => {
      const p = join(dir, name)
      writeFileSync(p, '#!/bin/sh\nexit 1\n')
      chmodSync(p, 0o755)
      return p
    }
    const chatFor = (dir: string, env: Record<string, string | undefined>): ChatService =>
      new ChatService({
        skillSource: join(dir, 'skill'), userData: join(dir, 'userData'),
        emit: () => {}, openExternal: async () => {}, sidecarBusy: () => false,
        venvPython: () => null, bundledPython: () => null, isTrusted: () => false, env
      })

    test('옵션 없이 부른 탐색이 동봉본을 찾고, PATH 설치본보다 앞선다 (윈도우)', async () => {
      const bundled = mkdtempSync(join(tmpdir(), 'kd-def-bundle-'))
      const onPath = mkdtempSync(join(tmpdir(), 'kd-def-path-'))
      const bundledExe = fakeExe(bundled)
      fakeExe(onPath)
      await withBundled(bundled, () => {
        // 옵션 없이(= 실제 소비 경로들과 같은 방식으로) 부른다.
        expect(findExecutable('codex', { Path: onPath, USERPROFILE: bundled })).toBe(bundledExe)
      })
    })

    test('첫 화면·폴더별 연결: 동봉본만 있으면 설치 안내로 떨어지지 않는다 (윈도우)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kd-svc-'))
      const bundled = mkdtempSync(join(tmpdir(), 'kd-svc-bin-'))
      const exe = fakeExe(bundled)
      await withBundled(bundled, async () => {
        // 소비 경로가 하는 바로 그 호출 — 동봉본이 뽑힌다(별도 설치가 없어도).
        expect(findExecutable('codex')).toBe(exe)
        const chat = chatFor(dir, {})
        // 전역(첫 화면) — 설치 안내 분기(installed:false)가 아니라 연결 시도까지 간다.
        const global = await chat.globalStatus('codex')
        expect(global.installed).toBe(true)
        expect(global.probe).toBe('failed')  // 가짜 CLI 라 연결은 실패한다 — 그 전에 찾긴 찾았다
        // 폴더별 연결도 같은 기본 탐색을 쓴다: 설치 안내로 떨어지지 않는다.
        const perFolder = await chat.status(join(dir, 'proj'), 'codex').catch((e) => ({ installed: true, detail: String(e) }))
        expect(perFolder.installed).not.toBe(false)
      })
    })

    test('KNUAF_AGENT_PATH_ONLY=1 이면 동봉도 PATH 도 아니면 설치 안내 — 종전 의미 보존', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kd-only-svc-'))
      const bundled = mkdtempSync(join(tmpdir(), 'kd-only-bin-'))
      fakeExe(bundled)
      await withBundled(bundled, async () => {
        expect(findExecutable('codex')).toBeNull()
        const chat = chatFor(dir, {})
        const global = await chat.globalStatus('codex')
        expect(global.installed).toBe(false)
        expect(String(global.detail)).toContain('설치 안내')
        const perFolder = await chat.status(join(dir, 'proj'), 'codex')
        expect(perFolder.installed).toBe(false)
      }, { KNUAF_AGENT_PATH_ONLY: '1' })
    })

    test('맥에서는 동봉 자리를 아예 보지 않는다 — 종전 그대로', () => {
      const dir = mkdtempSync(join(tmpdir(), 'kd-mac-'))
      fakeExe(dir, 'knuaf-bundle-probe')  // 맥 이름 규칙: `.exe` 는 후보가 아니다
      expect(bundledDirs('darwin')).toEqual([])
      const prevDirs = setBundledDirsProvider(() => [dir])
      try {
        expect(findExecutable('knuaf-bundle-probe', { PATH: '', HOME: dir }, { platform: 'darwin' })).toBe(join(dir, 'knuaf-bundle-probe'))
      } finally { setBundledDirsProvider(prevDirs) }
    })
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
    expect(source).toBe(resolve(appRoot, '..', 'skills', 'knuaf-dev'))
    expect(existsSync(join(source, 'SKILL.md'))).toBe(true)
    // 패키지 배치는 `resourcesPath` 아래 `skill` 이다 — 조립은 join 이 하므로 기대값도 join 으로
    // 만든다(윈도우에서는 역슬래시가 나온다). 리터럴 '/' 로 견주면 윈도우에서만 어긋난다.
    expect(skillSource(appRoot, true, '/App/Contents/Resources')).toBe(join('/App/Contents/Resources', 'skill'))
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
    expect(targets.claude).toBe(join(root, '.claude', 'skills', 'knuaf-dev'))
    expect(targets.codex).toBe(join(root, '.agents', 'skills', 'knuaf-dev'))
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
    expect(readdirSync(targets.claude).sort()).toEqual(['.knuaf-dev-version', 'SKILL.md', 'references', 'scripts'])

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
    expect(readdirSync(join(root, '.claude', 'skills'))).toEqual(['knuaf-dev'])
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
    }, 'darwin')   // 맥 기대 시험은 플랫폼을 명시한다 — 윈도우 기대는 별도 시험이 맡는다
    expect(s.startsWith('#!/bin/bash\n')).toBe(true)
    expect(s).toContain(`cd '/tmp/논문 폴더' || exit 1`)
    expect(s).toContain(`export PATH='/tmp/논문 폴더/.venv/bin':'/App/Resources/python/bin':'/opt/homebrew/bin':'/usr/local/bin':"$HOME/.local/bin":"$PATH"`)
    expect(s).toContain('export KNUAF_DOC_APP=1')
    // ~/.claude/CLAUDE.md의 @import가 외부 경로를 가리키면 학생에게 영어 보안 프롬프트가 뜬다 —
    // 이 앱이 띄우는 도우미는 메모리 파일을 아예 읽지 않는다.
    expect(s).toContain('export CLAUDE_CODE_DISABLE_CLAUDE_MDS=1')
    expect(s).toContain('KNUAF-Dev 가 AI 도우미를 엽니다')
    // 비상구(외부 터미널)에도 채팅과 같은 가드레일 — 프로젝트 스킬만 유효 + 도구 팝업 차단.
    // `--disallowedTools=…` 는 `=` 필수 — 공백이면 가변 인자가 첫 프롬프트를 삼킨다.
    expect(s).toContain(`exec '/opt/homebrew/bin/claude' --setting-sources project,local '--disallowedTools=AskUserQuestion' '시작하기'`)
  })

  /**
   * 형님 승인 W1 연결 기제 ④. 윈도우에는 `.command`(bash)가 없으므로 `.cmd`(배치)를 낸다 —
   * 같은 일(작업 폴더로 이동·PATH·환경변수·가드레일)을 하고, cmd 가 담을 수 없는 것만 다르다.
   */
  test('win32 는 .cmd 배치로 같은 일을 한다 — 첫 프롬프트는 한 줄로 눌러 담는다', () => {
    const o = {
      root: 'C:\\Users\\학생\\내 논문', agent: 'claude' as const,
      agentPath: 'C:\\Users\\학생\\AppData\\Roaming\\npm\\claude.cmd',
      venvBin: 'C:\\Users\\학생\\내 논문\\.venv\\Scripts', bundledBin: null,
      firstPrompt: firstPromptFor(3, 'C:\\Users\\학생\\내 논문')
    }
    const s = buildLaunchScript(o, 'win32')
    expect(s.startsWith('@echo off\r\n')).toBe(true)
    // 지연 확장을 끈다(`!` 가 경로·문장에서 글자 그대로 가게).
    expect(s).toContain('\r\nsetlocal DisableDelayedExpansion\r\n')
    // 작업 폴더로 이동(드라이브까지) — 공백·한글 경로가 인용된다.
    expect(s).toContain('cd /d "C:\\Users\\학생\\내 논문" || exit /b 1')
    // PATH 는 `;` 이고 .venv 가 앞에 온다. 원래 PATH 를 덮지 않는다.
    expect(s).toContain('set "PATH=C:\\Users\\학생\\내 논문\\.venv\\Scripts;%PATH%"')
    expect(s).toContain('set "KNUAF_DOC_APP=1"')
    expect(s).toContain('set "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1"')
    // 채팅과 같은 가드레일 — 프로젝트 스킬만, 도구 팝업은 끈다.
    expect(s).toContain('--setting-sources project,local')
    expect(s).toContain('--disallowedTools=AskUserQuestion')
    // 첫 프롬프트는 **한 줄**이고 그 글자는 살아 있다(cmd 인자에는 줄바꿈이 못 들어간다).
    expect(s).toContain('이어서')
    expect(s).toContain('작업')
    expect(s).not.toContain('이어서 하기\r\n')
    // 맥 스크립트의 것(셔뱅·exec·export)은 없다.
    expect(s).not.toContain('#!/bin/bash')
    expect(s).not.toContain('export ')
    expect(s).not.toContain('exec ')
    // 확장자가 실행물을 정한다(윈도우에는 실행 비트가 없다).
    expect(launchScriptExt('win32')).toBe('.cmd')
    expect(launchScriptExt('darwin')).toBe('.command')
  })

  /** W1C-R1-01(④) — 배치의 확장 단계는 명령줄과 달라 `%`→`%%`, 메타문자는 따로 막는다. */
  test('win32 배치는 배치 확장 규칙으로 막는다 — `%`·`&`·`!`·공백 (W1 ④)', () => {
    const o = {
      root: 'C:\\Users\\A&B\\내 논문', agent: 'claude' as const,
      agentPath: 'C:\\Program Files\\npm\\claude.cmd',
      venvBin: null, bundledBin: null, firstPrompt: '100% & 확인!'
    }
    const s = buildLaunchScript(o, 'win32')
    // `%` 는 배치에서 `%%` 로 적어야 글자 그대로다(배치는 거절하지 않는다 — 확장 단계가 다르다).
    expect(s).toContain('100%%')
    // 실행 줄의 `&`·`!` 는 전부 `^` 뒤에 있다(따옴표만으로는 cmd 가 막지 못한다).
    const exec = s.split('\r\n').find((l) => l.includes('claude.cmd'))
    expect(exec, '실행 줄이 없다').toBeTruthy()
    expect(exec).not.toMatch(/(^|[^^])&/)
    expect(exec).not.toMatch(/(^|[^^])!/)
    // **실행 파일 경로는 한 층만** — shim 의 `%*` 로 다시 해석되지 않는다(W1C-R1-01 확인).
    // 두 층이면 첫 해석 뒤에도 `^` 가 남아 프로그램 이름을 찾지 못한다.
    const cmdPart = exec!.split(' --setting-sources ')[0]
    expect(cmdPart).toMatch(/Program\^ Files/)
    expect(cmdPart).not.toContain('^^')
    expect(cmdPart).not.toContain('^"')
    // `cd` 는 따옴표 안이라 `&` 가 그대로여도 안전하다.
    expect(s).toContain('cd /d "C:\\Users\\A&B\\내 논문" || exit /b 1')
  })

  /**
   * W1C-R1-01(④) **실행** 반례 — 생성한 배치를 직접 `cmd /d /c` 로 돌린다(터미널 창 없이).
   * 가짜 `codex.cmd` 가 받은 argv 를 남기고, `Program Files` 공백 경로·`A&B` 홈의 설정값·
   * `&` 부수 명령이 명령으로 갈라지지 않았는지 본다. 맥은 문자열 단언만 — skip 아니라 분기다.
   */
  test('win32 배치를 실제로 실행해도 argv 가 그대로 온다 (W1 ④, 실행)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kd-batch-'))
    // 루트는 ASCII 로 둔다 — 배치 **파일 내용**의 한글은 cmd 코드페이지에 달려 있어(별도 한계)
    // 여기서는 argv 보존만 본다. 한글 argv 는 ①(명령줄) 시험이 CreateProcessW 경로로 검사한다.
    const root = join(base, 'thesis folder')                // 공백
    const agentDir = join(base, 'Program Files', 'npm')    // 공백 경로
    const home = join(base, 'A&B')                         // cmd 메타문자
    const argvFile = join(base, 'argv.json')
    const marker = join(base, 'PWNED.txt')
    const recorder = join(base, 'recorder.mjs')
    const agentPath = join(agentDir, 'codex.cmd')
    for (const d of [root, agentDir, join(home, '.codex', 'skills', 'knuaf-dev')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(home, '.codex', 'skills', 'knuaf-dev', 'SKILL.md'), '# old\n', 'utf-8')
    writeFileSync(recorder, `import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))\n`, 'utf-8')
    // npm shim 과 같은 모양 — `%*` 로 인자를 그대로 넘긴다(그래서 인자만 두 번 막는다).
    writeFileSync(agentPath, `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`, 'utf-8')

    const config = codexSkillConfigOverride(home)!
    const codex = buildLaunchScript({ root, agent: 'codex', agentPath, venvBin: null, bundledBin: null, firstPrompt: '', home }, 'win32')
    // (문자열, 두 플랫폼) 명령은 한 층·인자는 `^` 뒤 — A&B 설정값이 갈라지지 않는다.
    const exec = codex.split('\r\n').find((l) => l.includes('codex.cmd'))!
    expect(exec.split(' -c ')[0]).toMatch(/Program\^ Files/)
    expect(exec.split(' -c ')[0]).not.toContain('^^')
    expect(exec).not.toMatch(/(^|[^^])&/)

    // `&` 뒤의 부수 명령 — 따옴표만으로는 막지 못하므로 실제 실행으로 확인한다.
    const evil = `x&echo PWNED>"${marker}"`
    const claude = buildLaunchScript({ root, agent: 'claude', agentPath, venvBin: null, bundledBin: null, firstPrompt: evil }, 'win32')
    expect(claude).not.toMatch(/(^|[^^])&/)
    if (process.platform !== 'win32') return

    const run = (script: string): Promise<number | null> => new Promise((resolve) => {
      const file = join(base, 'run.cmd')
      writeFileSync(file, script, 'utf-8')
      spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', file], { env: { ...process.env, ARGV_OUT: argvFile }, windowsHide: true, stdio: 'ignore' })
        .on('exit', resolve)
    })
    expect(await run(codex), 'codex 배치가 실패했다').toBe(0)
    expect(JSON.parse(readFileSync(argvFile, 'utf-8')), 'codex argv 가 다르다').toEqual(['-c', config])
    expect(existsSync(marker), '`&` 뒤의 부수 명령이 실행됐다').toBe(false)
    expect(await run(claude), 'claude 배치가 실패했다').toBe(0)
    expect(JSON.parse(readFileSync(argvFile, 'utf-8')), 'claude argv 가 다르다')
      .toEqual(['--setting-sources', 'project,local', '--disallowedTools=AskUserQuestion', evil])
    expect(existsSync(marker), '`&` 뒤의 부수 명령이 실행됐다').toBe(false)
  })

  test('codex gets no positional prompt and no -c without a global skill copy; sq escapes single quotes', () => {
    const s = buildLaunchScript({ root: '/x', agent: 'codex', agentPath: '/opt/homebrew/bin/codex', venvBin: null, bundledBin: null, firstPrompt: '시작하기' }, 'darwin')
    expect(s.trimEnd().split('\n').pop()).toBe(`exec '/opt/homebrew/bin/codex'`)
    expect(s).not.toContain('skills.config')
    expect(s).not.toContain("'시작하기'")
    expect(sq(`it's`)).toBe(`'it'\\''s'`)
    expect(firstPromptFor(0)).toBe('시작하기')
    expect(firstPromptFor(null)).toBe('시작하기')
    expect(firstPromptFor(3)).toBe('이어서 하기')
  })

  test('a stale global knuaf-dev copy is disabled for the external codex launch', () => {
    // ~/.codex/skills·~/.agents/skills 의 낡은 사본이 프로젝트 사본과 함께 enabled 로
    // 보이면 모델이 옛 지침을 따른다 — 비상구 터미널에서도 그 사본을 끈다.
    const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
    expect(codexSkillConfigOverride(home)).toBeNull()
    mkdirSync(join(home, '.codex', 'skills', 'knuaf-dev'), { recursive: true })
    writeFileSync(join(home, '.codex', 'skills', 'knuaf-dev', 'SKILL.md'), '# old\n')
    const cfg = codexSkillConfigOverride(home)
    // 제품은 TOML 문자열용으로 역슬래시를 두 번 쓴다 — 윈도우 경로 그대로 견주면 어긋나므로
    // 기대값에도 같은 이스케이프를 적용한다(맥에서는 역슬래시가 없어 종전과 같은 문자열).
    const esc = (p: string): string => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    expect(cfg).toBe(`skills.config=[{path="${esc(join(home, '.codex', 'skills', 'knuaf-dev', 'SKILL.md'))}",enabled=false}]`)
    const s = buildLaunchScript({ root: '/x', agent: 'codex', agentPath: '/opt/codex', venvBin: null, bundledBin: null, firstPrompt: '', home }, 'darwin')
    expect(s).toContain(`-c '${cfg}'`)

    // app-server 스폰에도 같은 오버라이드 — -c 는 subcommand 앞의 루트 인자다.
    expect(serverArgsFor({ HOME: home })).toEqual(['-c', cfg, 'app-server'])
    expect(serverArgsFor({ HOME: join(mkdtempSync(join(tmpdir(), 'kd-home-')), 'none') })).toEqual(['app-server'])
    // ~/.agents/skills 도 스캔 대상 — 두 사본이 함께 있으면 둘 다 끈다.
    mkdirSync(join(home, '.agents', 'skills', 'knuaf-dev'), { recursive: true })
    writeFileSync(join(home, '.agents', 'skills', 'knuaf-dev', 'SKILL.md'), '# old\n')
    expect(serverArgsFor({ HOME: home })[1]).toContain('.agents')
  })
})

test.describe('launch', () => {
  test('dryRun writes an executable launch script and never calls open', async () => {
    const supportDir = join(mkdtempSync(join(tmpdir(), 'kd-support-')), 'nested')
    let opened = 0
    const r = await launch({
      root: '/tmp/p', agent: 'claude', agentPath: '/opt/homebrew/bin/claude', venvBin: null, bundledBin: null,
      firstPrompt: '시작하기', supportDir, dryRun: true
    }, { open: async () => { opened++; return '' } })
    expect(r.scriptPath.startsWith(supportDir)).toBe(true)
    const win = process.platform === 'win32'
    expect(r.scriptPath).toMatch(win ? /launch-[0-9a-f]{8}\.cmd$/ : /launch-[0-9a-f]{8}\.command$/)
    const body = readFileSync(r.scriptPath, 'utf-8')
    if (win) {
      // 윈도우에는 POSIX 실행 비트가 없다 — 실행물을 정하는 것은 확장자다(위 단언).
      expect(body).toContain('--setting-sources project,local')
    } else {
      expect(statSync(r.scriptPath).mode & 0o111).toBeTruthy()
      expect(body).toContain(`exec '/opt/homebrew/bin/claude' --setting-sources project,local '--disallowedTools=AskUserQuestion' '시작하기'`)
    }
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
    expect(existsSync(join(root, '.agents', 'skills', 'knuaf-dev', 'SKILL.md'))).toBe(true)
    expect((await agentApi.status(ctx, root)).skill).toEqual({ claude: 'missing', codex: 'installed' })

    // launch resolves the real binary, so it only runs where claude is installed.
    // 같은 조건에서 **윈도우도** API 를 부른다 — 실행물 모양만 플랫폼별로 다르게 단언한다
    // (W1C-R1-03: 이 검사를 조건문으로 빼면 Windows 보증이 조용히 사라진다).
    if (claudePath) {
      const r = await agentApi.launch(ctx, { root: '/tmp/논문 폴더', kind: 'claude', revision: 2 })
      const script = readFileSync(r.scriptPath, 'utf-8')
      expect(opened, 'dry-run 인데 open 을 불렀다').toEqual([])
      if (process.platform === 'win32') {
        // 윈도우: 실행물은 `.cmd` 배치이고, 같은 ctx 조합(venv·프롬프트)이 그 안에 실린다.
        expect(r.scriptPath).toMatch(/launch-[0-9a-f]{8}\.cmd$/)
        expect(script).toContain('@echo off')
        expect(script).toContain('--setting-sources project,local')
        expect(script).toContain('--disallowedTools=AskUserQuestion')
        expect(script).toContain('/tmp/논문')          // 첫 프롬프트의 작업 폴더
        expect(script).toContain('.venv')              // ctx 가 준 venv 자리
      } else {
        expect(script).toContain(`cd '/tmp/논문 폴더' || exit 1`)
        expect(script).toContain(`export PATH='/tmp/논문 폴더/.venv/bin':`)
        expect(script).toContain(`exec '${claudePath}' --setting-sources project,local '--disallowedTools=AskUserQuestion' '이어서 하기`)
        expect(script).toContain(`작업 폴더: /tmp/논문 폴더`)
      }
    }
  })
})
