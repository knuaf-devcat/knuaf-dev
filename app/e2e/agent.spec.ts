// Unit tests for src/main/agent.ts. Plain Playwright `test()` in Node: no Electron is launched.
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  agentApi, buildLaunchScript, bundledAgentDirs, bundledDirs, codexSkillConfigOverride, findExecutable, firstPromptFor, installSkill, launch, launchScriptExt, probeVersion,
  setAgentPlatformForTest, setBundledDirsProvider, skillBackupDir, skillSource, skillState, skillTargets, skillVersion, sq, VERSION_FILE
} from '../src/main/agent'
import { serverArgsFor } from '../src/main/chat/codex'
import { pathKeyOf } from '../src/main/chat/contracts'
import { ChatService } from '../src/main/chat/service'

const appRoot = resolve(__dirname, '..')
const source = skillSource(appRoot, false, '/nonexistent')
// 시험이 process.env 를 건드리기 전 값 — 아래 복원 시험이 이 값과 비교한다(BUNDLE-WIN-ENV).
const pathBeforeTests = process.env[pathKeyOf(process.env)]
const homeBeforeTests = process.env.HOME

/**
 * env 를 잠시 바꾸고 **정확히** 되돌린다.
 *
 * 윈도우의 `process.env` 는 키 대소문자를 구분하지 않는다 — `Path` 와 `PATH` 는 같은 변수다.
 * 그래서 바꾼 키의 "이전 값"을 그때그때 읽어 되돌리면, 첫 키를 비운 뒤 두 번째 키를 읽을 때 이미
 * 빈 값이 잡히고, 복원에서 그 빈 값이 원래 값을 덮어쓴다. 실제로 동봉 시험이 윈도우 CI 에서
 * PATH 를 빈 채로 끝나 다음 파일(`chat.spec.ts`)의 PATH 시험을 깨뜨렸다(BUNDLE-WIN-ENV).
 *
 * 그래서 바꾸기 전 **전체 키·값을 스냅샷**하고, 복원할 때는 현재 키를 모두 지운 뒤 스냅샷을
 * (대소문자 무시로 짝지어) 그대로 다시 넣는다. 맥처럼 두 키가 다른 변수인 곳에서도 같다.
 */
async function withEnv<T>(
  patch: Record<string, string>,
  fn: () => T | Promise<T>,
  env: Record<string, string | undefined> = process.env
): Promise<T> {
  const keys = Object.keys(env)
  const before = new Map(keys.map((k) => [k, env[k]] as const))
  // 윈도우용 보조 색인 — 스냅샷에 `Path` 하나뿐인데 복원 루프가 다른 표기로 돌 때 쓴다.
  // 정확한 키가 있으면 언제나 그쪽이 이긴다(맥은 `PATH`·`Path` 가 서로 다른 변수다).
  const beforeLower = new Map(keys.map((k) => [k.toLowerCase(), env[k]] as const))
  try {
    for (const [k, v] of Object.entries(patch)) env[k] = v
    return await fn()
  } finally {
    for (const k of Object.keys(env)) delete env[k]
    for (const k of keys) {
      const v = before.has(k) ? before.get(k) : beforeLower.get(k.toLowerCase())
      if (v !== undefined) env[k] = v
    }
  }
}

/**
 * 윈도우 `process.env` 흉내 — 키를 대소문자 무시로 다루고, 변수마다 원래 키 이름 하나만 남긴다.
 * 맥에서는 `PATH` 와 `Path` 가 서로 다른 변수라 이 누수를 재현할 수 없어서 시험용으로 만든다.
 */
function winLikeEnv(init: Record<string, string>): Record<string, string> {
  const vars = new Map<string, { name: string; value: string }>()
  for (const [k, v] of Object.entries(init)) vars.set(k.toLowerCase(), { name: k, value: v })
  return new Proxy({} as Record<string, string>, {
    get: (_t, prop) => (typeof prop === 'string' ? vars.get(prop.toLowerCase())?.value : undefined),
    set: (_t, prop, value) => {
      if (typeof prop !== 'string') return false
      const key = prop.toLowerCase()
      vars.set(key, { name: vars.get(key)?.name ?? prop, value: String(value) })
      return true
    },
    deleteProperty: (_t, prop) => (typeof prop === 'string' ? vars.delete(prop.toLowerCase()) : true),
    has: (_t, prop) => (typeof prop === 'string' ? vars.has(prop.toLowerCase()) : false),
    ownKeys: () => [...vars.values()].map((v) => v.name),
    getOwnPropertyDescriptor: (_t, prop) => {
      const v = typeof prop === 'string' ? vars.get(prop.toLowerCase()) : undefined
      return v ? { enumerable: true, configurable: true, value: v.value } : undefined
    }
  })
}

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
     * 검사하려면 process.env 를 잠시 바꿔야 한다. 끝나면 `withEnv` 가 정확히 되돌린다 —
     * 윈도우에서는 `Path` 와 `PATH` 가 같은 변수라 별칭을 함께 만지면 복원이 서로를 덮어쓴다.
     */
    const withBundled = (dir: string, fn: () => void | Promise<void>, envPatch: Record<string, string> = {}) => {
      const prevPlatform = setAgentPlatformForTest('win32')
      const prevDirs = setBundledDirsProvider(() => [dir])
      // 플랫폼의 **실제** PATH 키 하나만 다룬다(윈도우면 `Path`).
      const patch: Record<string, string> = { [pathKeyOf(process.env)]: '', HOME: dir, USERPROFILE: dir, ...envPatch }
      return (async () => {
        try {
          await withEnv(patch, fn)
        } finally {
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

    /**
     * BUNDLE-WIN-ENV 재현 — 윈도우 CI 에서 이 시험들이 PATH 를 빈 채로 끝나 다음 파일
     * (`chat.spec.ts`)의 PATH 시험을 깨뜨렸다. 맥에서는 `PATH`·`Path` 가 다른 변수라 재현되지
     * 않으므로, 윈도우처럼 대소문자를 무시하는 env 를 만들어 **복원 로직 자체**를 검사한다.
     */
    test('env 복원은 윈도우의 키 대소문자 무시에서도 원래 값으로 돌아온다 (BUNDLE-WIN-ENV)', async () => {
      const win = winLikeEnv({ Path: 'C:\\Windows\\System32', HOME: '/Users/s' })
      await withEnv({ Path: '', PATH: '' }, async () => { expect(win.Path).toBe(''); expect(win.PATH).toBe('') }, win)
      expect(win.PATH).toBe('C:\\Windows\\System32')   // 키별 "이전 값" 복원은 여기서 '' 를 남겼다
      expect(win.Path).toBe('C:\\Windows\\System32')
      expect(Object.keys(win)).toEqual(['Path', 'HOME'])  // 별칭이 새 변수로 늘어나지도 않는다
      // 맥처럼 서로 다른 변수인 곳에서도 그대로 동작한다.
      const mac = { PATH: '/usr/bin', Path: 'x' }
      await withEnv({ PATH: '' }, () => { expect(mac.PATH).toBe('') }, mac)
      expect(mac.PATH).toBe('/usr/bin')
      expect(mac.Path).toBe('x')
    })

    /** 발주서 요청 — 시험이 끝난 뒤 실제 환경이 원래대로인지 여기서 단언한다. */
    test('동봉 시험 뒤에도 PATH 가 비지 않는다 — 다음 파일로 새지 않는다 (BUNDLE-WIN-ENV)', () => {
      // 윈도우 CI 에서 종전 코드는 여기서 '' 였고, 그래서 다음 파일의 PATH 시험이 깨졌다.
      expect(process.env[pathKeyOf(process.env)]).toBe(pathBeforeTests)
      expect(process.env.HOME).toBe(homeBeforeTests)
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
    // 실기기 QA-04 — 둘째 줄에서 UTF-8 코드페이지로 바꾼다. cmd 는 배치를 콘솔 코드페이지(949)로
    // 읽으므로, 그 전 줄들은 ASCII 여야 하고 한글은 그 뒤에만 나온다.
    const lines = s.split('\r\n')
    expect(lines[1]).toBe('chcp 65001 >nul')
    expect(lines.slice(0, 2).join('\r\n')).toMatch(/^[\x20-\x7e\r\n]*$/)
    expect(s.charCodeAt(0), 'BOM 이 있으면 첫 줄이 깨진다').toBe('@'.charCodeAt(0))
    // 지연 확장을 끈다(`!` 가 경로·문장에서 글자 그대로 가게).
    expect(s).toContain('\r\nsetlocal DisableDelayedExpansion\r\n')
    // 작업 폴더로 이동(드라이브까지) — 공백·한글 경로가 인용된다. 실패하면 창을 남긴다.
    expect(s).toContain('cd /d "C:\\Users\\학생\\내 논문" || exit /b 1')
    // 도우미가 오류로 끝나면 창을 남긴다(바로 닫히면 학생이 이유를 못 본다).
    expect(s).toContain('set "KNUAF_LAUNCH_EXIT=%errorlevel%"')
    expect(s).toContain('pause\r\nexit /b %KNUAF_LAUNCH_EXIT%')
    expect(s).toContain('if "%KNUAF_LAUNCH_EXIT%"=="0" exit /b 0')
    expect(lines.filter(Boolean).at(-1)).toBe('exit /b %errorlevel%')
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
   * 실기기 QA-04 — 설치본은 `codex.exe` 를 동봉한다. `.exe` 는 cmd 가 한 번 읽고 바로 MSVCRT 로
   * 넘기므로 인자의 `^` 는 **한 층**이다. 두 층이면 `^"` 가 남아 `-c` 설정값이 깨진다.
   */
  test('win32 배치 — 대상이 .exe 면 인자를 한 층만 막는다 (QA-04)', () => {
    const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
    mkdirSync(join(home, '.codex', 'skills', 'knuaf-dev'), { recursive: true })
    writeFileSync(join(home, '.codex', 'skills', 'knuaf-dev', 'SKILL.md'), '# old\n')
    const base = { root: 'C:\\Users\\이뚠냥\\Downloads\\QA 한글 시험', agent: 'codex' as const, venvBin: null, bundledBin: null, firstPrompt: '', home }
    const exeLine = buildLaunchScript({ ...base, agentPath: 'C:\\Program Files\\knuaf\\resources\\codex\\codex.exe' }, 'win32')
      .split('\r\n').find((l) => l.includes('codex.exe'))!
    const shimLine = buildLaunchScript({ ...base, agentPath: 'C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd' }, 'win32')
      .split('\r\n').find((l) => l.includes('codex.cmd'))!
    const exeArg = exeLine.split(' -c ')[1]
    const shimArg = shimLine.split(' -c ')[1]
    expect(exeArg.startsWith('^"skills.config=')).toBe(true)
    expect(exeArg).not.toContain('^^')
    expect(shimArg.startsWith('^^^"skills.config=')).toBe(true)
  })

  /**
   * W1C-R1-01(④) **실행** 반례 — 생성한 배치를 직접 `cmd /d /c` 로 돌린다(터미널 창 없이).
   * 가짜 `codex.cmd` 가 받은 argv 를 남기고, `Program Files` 공백 경로·`A&B` 홈의 설정값·
   * `&` 부수 명령이 명령으로 갈라지지 않았는지 본다. 맥은 문자열 단언만 — skip 아니라 분기다.
   */
  test('win32 배치를 실제로 실행해도 argv 가 그대로 온다 (W1 ④, 실행)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kd-batch-'))
    // 실기기 QA-04 — 루트·홈에 **한글과 공백**을 둔다. 배치 파일은 UTF-8 이고 cmd 는 콘솔
    // 코드페이지(한국어 949, CI 러너 437)로 읽으므로, `chcp 65001` 이 없으면 `cd` 부터 실패한다.
    const root = join(base, '한글 논문 폴더')                // 한글 + 공백
    const agentDir = join(base, 'Program Files', 'npm')    // 공백 경로
    const home = join(base, '이뚠냥 A&B')                    // 한글 + cmd 메타문자
    const argvFile = join(base, 'argv.json')
    const marker = join(base, 'PWNED.txt')
    const recorder = join(base, 'recorder.mjs')
    const agentPath = join(agentDir, 'codex.cmd')
    for (const d of [root, agentDir, join(home, '.codex', 'skills', 'knuaf-dev')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(home, '.codex', 'skills', 'knuaf-dev', 'SKILL.md'), '# old\n', 'utf-8')
    writeFileSync(recorder, `import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.ARGV_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))\n`, 'utf-8')
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

    const run = (script: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string }> => new Promise((resolve, reject) => {
      const file = join(base, 'run.cmd')
      writeFileSync(file, script, 'utf-8')
      // 실기기와 같은 CP949에서 시작한다. ASCII 진입 배치가 생성한 UTF-8 배치를 읽는다.
      const entry = join(base, 'start.cmd')
      writeFileSync(entry, '@echo off\r\nchcp 949 >nul\r\n"%~dp0run.cmd"\r\n', 'utf-8')
      const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', entry], { env: { ...process.env, ARGV_OUT: argvFile, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout.setEncoding('utf-8').on('data', (s) => { stdout += s })
      child.stderr.setEncoding('utf-8').on('data', (s) => { stdout += s })
      child.on('error', reject).on('close', (code) => resolve({ code, stdout }))
    })
    const recorded = (): { argv: string[]; cwd: string } => JSON.parse(readFileSync(argvFile, 'utf-8'))
    expect((await run(codex)).code, 'codex 배치가 실패했다(한글 경로로 cd 하지 못했을 수 있다)').toBe(0)
    expect(recorded().argv, 'codex argv 가 다르다').toEqual(['-c', config])
    expect(realpathSync.native(recorded().cwd), '한글·공백 작업 폴더로 이동하지 않았다').toBe(realpathSync.native(root))
    expect(existsSync(marker), '`&` 뒤의 부수 명령이 실행됐다').toBe(false)
    expect((await run(claude)).code, 'claude 배치가 실패했다').toBe(0)
    expect(recorded().argv, 'claude argv 가 다르다')
      .toEqual(['--setting-sources', 'project,local', '--disallowedTools=AskUserQuestion', evil])
    expect(existsSync(marker), '`&` 뒤의 부수 명령이 실행됐다').toBe(false)

    // 실기기 QA-04 — 설치본의 동봉 `codex.exe`(npm shim 이 아님). 받은 원래 argv 를 남기는 `.exe` 로
    // 파이썬 실행 파일을 `codex.exe` 이름으로 복사해 쓴다: `sitecustomize` 가 시작하자마자
    // `sys.orig_argv` 를 적고 끝낸다(`-c` 뒤 설정값은 코드로 실행되지 않는다).
    const py = process.env.KNUAF_PYTHON
    expect(py && existsSync(py), 'CI 는 KNUAF_PYTHON(절대 경로)을 준다 — .exe 실행 시험에 필요하다').toBeTruthy()
    const exeDir = join(base, 'Program Files', '동봉 codex')
    mkdirSync(exeDir, { recursive: true })
    const exe = join(exeDir, 'codex.exe')
    copyFileSync(py!, exe)
    for (const f of readdirSync(dirname(py!))) if (/\.dll$/i.test(f)) copyFileSync(join(dirname(py!), f), join(exeDir, f))
    const site = join(base, 'site')
    mkdirSync(site, { recursive: true })
    writeFileSync(join(site, 'sitecustomize.py'), [
      'import json, os, sys',
      "with open(os.environ['ARGV_OUT'], 'w', encoding='utf-8') as f:",
      "    json.dump({'argv': sys.orig_argv[1:], 'cwd': os.getcwd()}, f)",
      "os._exit(int(os.environ.get('FAKE_AGENT_EXIT', '0')))",
      ''
    ].join('\n'), 'utf-8')
    const exeScript = buildLaunchScript({ root, agent: 'codex', agentPath: exe, venvBin: null, bundledBin: null, firstPrompt: '', home }, 'win32')
    writeFileSync(argvFile, '{}', 'utf-8')
    expect((await run(exeScript, { PYTHONHOME: dirname(py!), PYTHONPATH: site })).code, 'codex.exe 배치가 실패했다').toBe(0)
    expect(recorded().argv, 'codex.exe 가 받은 설정값이 다르다(^ 가 남았을 수 있다)').toEqual(['-c', config])
    expect(realpathSync.native(recorded().cwd), '한글·공백 작업 폴더로 이동하지 않았다').toBe(realpathSync.native(root))

    // 실패 시 원래 종료 코드와 안내가 남는다. shim은 직접 실행하면 부모로 돌아오지 않는다.
    writeFileSync(agentPath, '@echo off\r\nexit /b 7\r\n', 'utf-8')
    const shimFailure = await run(codex)
    expect(shimFailure.code, shimFailure.stdout).toBe(7)
    expect(shimFailure.stdout).toContain('종료 코드: 7')
    const exeFailure = await run(exeScript, { PYTHONHOME: dirname(py!), PYTHONPATH: site, FAKE_AGENT_EXIT: '9' })
    expect(exeFailure.code, exeFailure.stdout).toBe(9)
    expect(exeFailure.stdout).toContain('종료 코드: 9')
    const missingRoot = buildLaunchScript({ root: join(base, '없는 폴더'), agent: 'codex', agentPath: exe, venvBin: null, bundledBin: null, firstPrompt: '' }, 'win32')
    const cdFailure = await run(missingRoot)
    expect(cdFailure.code, cdFailure.stdout).toBe(1)
    expect(cdFailure.stdout).toContain('종료 코드: 1')
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
