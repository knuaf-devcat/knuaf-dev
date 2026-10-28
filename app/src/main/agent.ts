/**
 * AI agent (Claude Code / Codex CLI) discovery, skill installation and terminal launch.
 *
 * Deliberately free of `electron` imports: every environment-specific value (home dir, app root,
 * packaged state, `shell.openPath`, venv lookup) is passed in through `AgentCtx`, so the module can be
 * unit-tested from plain Node (see e2e/agent.spec.ts). ipc.ts wires `agentApi` to IPC handlers.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { accessSync, chmodSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { APP_NAME_SHORT } from '../shared/name'
import { pathKeyOf } from './chat/contracts'
import { renameWithRetry } from './safeWrite'
import { winSpawn } from './win'

// ---------------------------------------------------------------- types

export type AgentKind = 'claude' | 'codex'
export type SkillState = 'installed' | 'outdated' | 'missing'

export interface AgentBinary { found: boolean; path: string | null; version: string | null }

export interface AgentStatus {
  claude: AgentBinary
  codex: AgentBinary
  skill: { claude: SkillState; codex: SkillState }
  skillVersion: string
}

export interface InstallResult { action: 'installed' | 'updated' | 'unchanged'; backup?: string }

export interface LaunchScriptOptions {
  root: string
  agent: AgentKind
  agentPath: string
  venvBin: string | null
  bundledBin: string | null
  firstPrompt: string
  /** $HOME — codex 의 전역 스킬 사본을 끄는 `-c` 오버라이드를 만들 때 쓴다. */
  home?: string
}

export interface LaunchOptions extends LaunchScriptOptions {
  supportDir: string
  /** When true the script is written but `open` is never called (env KNUAF_DRY_LAUNCH=1). */
  dryRun?: boolean
}

export interface LaunchDeps {
  writeFile?: (path: string, data: string, mode: number) => void
  chmod?: (path: string, mode: number) => void
  /** Electron `shell.openPath` injected by main; resolves to '' on success or an error string. */
  open?: (path: string) => Promise<string>
}

export interface LaunchResult { scriptPath: string }

/** Everything the main process knows that this module needs. Built once in ipc.ts. */
export interface AgentCtx {
  home: string
  appRoot: string
  isPackaged: boolean
  resourcesPath: string
  supportDir: string
  dryRun: boolean
  open: (path: string) => Promise<string>
  venvPython: (root: string | null) => string | null
  /** Optional: bundled interpreter, so its bin dir can be put on PATH for the agent. */
  bundledPython?: () => string | null
  /** Defaults to process.env; tests pass their own PATH/HOME. */
  env?: Record<string, string | undefined>
}

// ---------------------------------------------------------------- 2. executables

const EXTRA_DIRS = (home: string): string[] => [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(home, '.local', 'bin'),
  join(home, '.npm-global', 'bin'),
  join(home, '.npm', 'bin')
]

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface FindExecutableOptions {
  /** 테스트가 갈아 끼우는 플랫폼(기본은 hostPlatform()). */
  platform?: NodeJS.Platform
  /**
   * PATH **앞에** 둘 디렉터리. 주지 않으면 동봉 자리(bundledDirs)를 쓴다 — 이 기본값이
   * 첫 화면(`connect:status`)과 로그인·채팅(`ChatService`)까지 같은 규칙을 퍼뜨리는 통로다.
   * `KNUAF_AGENT_PATH_ONLY=1` 이면 어느 쪽이든 무시한다("도구 없음" 화면 시험 이음매).
   */
  leadingDirs?: string[]
}

// 시험 이음매 두 개 — 단위 시험이 플랫폼과 동봉 위치를 주입한다(제품 경로는 손대지 않는다).
let platformOverride: NodeJS.Platform | null = null

/** 호스트 플랫폼. 시험이 윈도우 분기를 돌릴 수 있게 갈아 끼울 수 있다(돌려주면 복원). */
export function hostPlatform(): NodeJS.Platform {
  return platformOverride ?? process.platform
}

export function setAgentPlatformForTest(platform: NodeJS.Platform | null): NodeJS.Platform | null {
  const prev = platformOverride
  platformOverride = platform
  return prev
}

/**
 * 동봉한 CLI 를 찾을 자리의 **기본값**. 패키지에서는 `process.resourcesPath`, 개발 트리에서는
 * `out/main` 기준 `../../resources`(python.ts 의 APP_ROOT 와 같은 기준)를 본다.
 * 윈도우가 아니면 빈 배열 — 맥 설치본에는 동봉하지 않기로 했다(형님 범위 결정).
 */
function defaultBundledDirs(platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return []
  const roots: string[] = []
  const resources = (process as { resourcesPath?: string }).resourcesPath
  if (typeof resources === 'string' && resources) roots.push(join(resources, 'codex'))
  if (typeof __dirname === 'string') roots.push(join(__dirname, '..', '..', 'resources', 'codex'))
  return roots.map((root) => join(root, 'vendor', 'x86_64-pc-windows-msvc', 'bin'))
}

let bundledDirsProvider: (platform: NodeJS.Platform) => string[] = defaultBundledDirs

/** 시험 이음매: 동봉 자리 공급자를 갈아 끼우고 이전 것을 돌려준다. */
export function setBundledDirsProvider(fn: (platform: NodeJS.Platform) => string[]): (platform: NodeJS.Platform) => string[] {
  const prev = bundledDirsProvider
  bundledDirsProvider = fn
  return prev
}

/** 동봉 자리(PATH 앞에 놓일 디렉터리들). 모든 소비 경로가 이 함수를 거친다. */
export function bundledDirs(platform: NodeJS.Platform = hostPlatform()): string[] {
  return bundledDirsProvider(platform)
}

/**
 * First executable named `name` on env.PATH, then in the usual user-install dirs. Absolute path or null.
 *
 * 순서는 **동봉본 → PATH → EXTRA_DIRS** 다. 동봉본을 먼저 두는 이유: 학생 PC 에 다른 버전의
 * codex 가 깔려 있어도 앱이 시험한 조합으로 동작한다.
 *
 * `KNUAF_AGENT_PATH_ONLY=1` 은 PATH 만 본다 — 시험용 이음매다. Finder 로 띄운 앱은 셸의
 * PATH 를 물려받지 않아(/usr/bin:/bin:/usr/sbin:/sbin) 아래 EXTRA_DIRS 가 사실상 유일한
 * 발견 경로인데, 그래서 시험에서 PATH 를 비워도 개발 기계에서는 진짜 codex 가 계속
 * 발견됐다. "도구 없음" 화면은 그 상태를 재현할 방법이 있어야 시험된다.
 */
export function findExecutable(
  name: string,
  env: Record<string, string | undefined> = process.env,
  opts: FindExecutableOptions = {}
): string | null {
  const platform = opts.platform ?? hostPlatform()
  const home = env.HOME ?? env.USERPROFILE ?? ''
  const sep = platform === 'win32' ? ';' : ':'
  // 윈도우에서 실제 키는 `Path` 인 경우가 많다 — 복사된 env(`AgentCtx.env`·시험 입력)에서도
  // 같은 규칙으로 읽어야 도구를 찾는다(검토 W1D-R1-02). 맥은 종전 그대로 `PATH`.
  const fromPath = (env[pathKeyOf(env, platform)] ?? '').split(sep).filter(Boolean)
  const dirs = env.KNUAF_AGENT_PATH_ONLY === '1'
    ? fromPath
    : [...(opts.leadingDirs ?? bundledDirs(platform)), ...fromPath, ...EXTRA_DIRS(home)]
  const names = platform === 'win32' ? winCandidateNames(name) : [name]
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    for (const n of names) {
      const candidate = join(dir, n)
      if (isAbsolute(candidate) && isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * 윈도우에서 찾아 볼 파일 이름들. **확장자 없는 이름은 넣지 않는다** — `CreateProcess` 는
 * 확장자를 스스로 붙이지 않으므로 그 이름은 띄울 수 없고, npm 이 깐 Claude Code 는 한 폴더에
 * `claude`(셸 스크립트)와 `claude.cmd`(실행 shim)를 같이 둔다. 확장자 없는 쪽을 먼저 집으면
 * `execFile` 이 ENOENT 로 죽어 로그인돼 있어도 "연결 상태를 확인하지 못했어요"가 떴다
 * (CL-WIN-01, 윈도우 실기기).
 *
 * `.exe` 를 먼저 본다: 네이티브 설치본은 cmd.exe 를 거치지 않아 인자 이스케이프(`winSpawn` 의
 * `%` 거절 포함)가 필요 없고, `probeVersion` 처럼 셸 없이 띄우는 호출에서도 그대로 동작한다.
 * `.cmd`·`.bat` 은 npm shim 이고 실행 경로들이 `winSpawn` 으로 감싼다.
 */
function winCandidateNames(name: string): string[] {
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`]
}

/**
 * 설치본에 동봉한 Codex CLI 의 bin 디렉터리. **윈도우에서만** 본다 — 맥 설치본에는 동봉하지
 * 않기로 했고(형님 범위 결정), 맥은 지금처럼 학생이 직접 설치한 것을 쓴다.
 *
 * 동봉본은 자기 패키지 레이아웃(`codex-package.json`·`codex-path/rg.exe`·`codex-resources/`)을
 * 스스로 찾으므로 bin 디렉터리만 알려 주면 rg·sandbox 도구도 함께 산다.
 * 개발 트리(out/)에서는 `resources/codex/…` 가 없으면 그냥 넘어간다(다음 후보로).
 */
export function bundledAgentDirs(
  ctx: Pick<AgentCtx, 'appRoot' | 'isPackaged' | 'resourcesPath'>,
  platform: NodeJS.Platform = hostPlatform()
): string[] {
  if (platform !== 'win32') return []
  const base = ctx.isPackaged ? ctx.resourcesPath : join(ctx.appRoot, 'resources')
  return [join(base, 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin')]
}

/**
 * `<path> --version`, trimmed first line; null on failure or after 8s.
 *
 * 윈도우에서 npm 이 깐 `.cmd` shim 은 셸 없이 띄울 수 없다(Node 의 CVE-2024-27980 수정 이후
 * EINVAL) — 그래서 다른 실행 경로(`chat/claude.ts`·`chat/transport.ts`)와 같은 `winSpawn` 을
 * 거친다. 이걸 빼면 찾은 도우미의 버전만 조용히 비어 배지가 빈칸으로 남는다.
 */
export function probeVersion(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const spec = winSpawn(path, ['--version'])
      execFile(spec.command, spec.args, { timeout: 8000, encoding: 'utf-8', windowsHide: true, ...spec.options }, (err, stdout) => {
        if (err) return resolve(null)
        const line = String(stdout).split(/\r?\n/).map((l) => l.trim()).find(Boolean)
        resolve(line ?? null)
      })
    } catch {
      resolve(null)
    }
  })
}

// ---------------------------------------------------------------- 3. skill source + version

/** Checkout: `<appRoot>/../skills/knuaf-dev`; packaged: `<resourcesPath>/skill` (see scripts/stage-skill.mjs). */
export function skillSource(appRoot: string, isPackaged: boolean, resourcesPath: string): string {
  return isPackaged ? join(resourcesPath, 'skill') : join(appRoot, '..', 'skills', 'knuaf-dev')
}

/** Walk `abs`, collecting "rel/path:sha256(content)" for the files installSkill copies. */
function skillFingerprint(abs: string, rel: string, out: string[]): void {
  if (!existsSync(abs)) return
  for (const name of readdirSync(abs)) {
    const child = join(abs, name)
    if (!copyFilter(child)) continue
    try {
      const st = statSync(child)
      if (st.isDirectory()) skillFingerprint(child, `${rel}/${name}`, out)
      else if (st.isFile()) out.push(`${rel}/${name}:${createHash('sha256').update(readFileSync(child)).digest('hex')}`)
    } catch { /* vanished between readdir and stat */ }
  }
}

/**
 * sha256 over the CONTENT of every installed file, first 12 hex. Stable across
 * machines for the same content.
 *
 * This used to hash SKILL.md plus `name:size` of scripts/*.py, which left two blind
 * spots: references/ was not hashed at all (replacing all 21 documents produced the
 * same version), and a same-length script edit was invisible. installSkill then
 * reported 'unchanged' and a project kept a stale copy of the rules.
 */
export function skillVersion(source: string): string {
  const h = createHash('sha256')
  const skillMd = join(source, 'SKILL.md')
  h.update(existsSync(skillMd) ? readFileSync(skillMd) : Buffer.alloc(0))
  const entries: string[] = []
  for (const dir of ['references', 'scripts']) skillFingerprint(join(source, dir), dir, entries)
  entries.sort()
  for (const e of entries) h.update('\n' + e)
  return h.digest('hex').slice(0, 12)
}

// ---------------------------------------------------------------- 4. targets + state

export const VERSION_FILE = '.knuaf-dev-version'

export const SKILL_NAME = 'knuaf-dev'

/**
 * 이름이 바뀌기 전의 스킬 폴더 이름. 학생 작업폴더에 이미 깔려 있던 것을 그대로 두면
 * 같은 스킬 둘이 함께 enabled 로 보여 모델이 옛 지침을 따를 수 있다 —
 * `skillBackupDir` 주석이 말하는 바로 그 사고다. 새로 깔 때 형제 자리에서 치운다.
 */
export const SUPERSEDED_SKILL_NAMES = ['knuaf-doc']

/** Project-local install dirs: the skill lives inside the open project, never in the user's home. */
export function skillTargets(root: string): Record<AgentKind, string> {
  return {
    claude: join(root, '.claude', 'skills', SKILL_NAME),
    codex: join(root, '.agents', 'skills', SKILL_NAME)
  }
}

export function skillState(target: string, version: string): SkillState {
  if (!existsSync(target)) return 'missing'
  try {
    const have = readFileSync(join(target, VERSION_FILE), 'utf-8').trim()
    return have === version ? 'installed' : 'outdated'
  } catch {
    return 'outdated'
  }
}

// ---------------------------------------------------------------- 5. install

function stamp(d = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const SKIP_NAMES = new Set(['__pycache__', '.venv', '.DS_Store'])
function copyFilter(src: string): boolean {
  const name = basename(src)
  return !SKIP_NAMES.has(name) && !name.endsWith('.pyc')
}

/**
 * Where a superseded copy goes. It must NOT be a sibling of `target`: a backup left
 * inside `<root>/.claude/skills/` is itself discovered as a skill, so the project ends
 * up with two near-identical knuaf-dev entries competing to be loaded.
 * `target` is `<root>/<.claude|.agents>/skills/knuaf-dev` (see skillTargets).
 */
export function skillBackupDir(target: string): string {
  const root = dirname(dirname(dirname(target)))
  return join(root, '.knuaf-gui', 'skill-backups')
}

/**
 * 옛 이름으로 깔려 있던 형제 폴더를 백업으로 옮긴다. 지우지 않는 이유는 그 안에
 * 학생이 손댄 것이 있을 수 있어서다 — 백업 자리는 skills/ 밖이라 다시 발견되지 않는다.
 * 새로 깔 것이 이미 최신이어도 돌려야 한다. 옛 폴더는 그와 무관하게 남아 있다.
 */
export function retireSupersededSkills(target: string): string[] {
  const skills = dirname(target)
  const moved: string[] = []
  for (const name of SUPERSEDED_SKILL_NAMES) {
    const old = join(skills, name)
    if (old === target || !existsSync(old)) continue
    const dir = skillBackupDir(target)
    mkdirSync(dir, { recursive: true })
    const kind = basename(dirname(skills))  // '.claude' | '.agents'
    let dest = join(dir, `${kind}-${name}-${stamp()}`)
    let i = 1
    while (existsSync(dest)) dest = join(dir, `${kind}-${name}-${stamp()}-${i++}`)
    // 윈도우에서 잠깐 막히면(EPERM/EBUSY/EACCES) 짧게 다시 시도한다 — 폴더 이동이라 폴백은 없다.
    renameWithRetry(old, dest)
    moved.push(dest)
  }
  return moved
}

/** Copy SKILL.md + references/ + scripts/ into `target` (only ever that directory), leaving a version marker. */
export function installSkill(source: string, target: string, version: string): InstallResult {
  retireSupersededSkills(target)
  const state = skillState(target, version)
  if (state === 'installed') return { action: 'unchanged' }

  let backup: string | undefined
  if (state === 'outdated') {
    const dir = skillBackupDir(target)
    mkdirSync(dir, { recursive: true })
    const kind = basename(dirname(dirname(target)))  // '.claude' | '.agents'
    backup = join(dir, `${kind}-${stamp()}`)
    let i = 1
    while (existsSync(backup)) backup = join(dir, `${kind}-${stamp()}-${i++}`)
    renameWithRetry(target, backup)
  }

  mkdirSync(target, { recursive: true })
  const skillMd = join(source, 'SKILL.md')
  if (!existsSync(skillMd)) throw new Error('스킬 원본에 SKILL.md가 없음: ' + source)
  cpSync(skillMd, join(target, 'SKILL.md'))
  for (const dir of ['references', 'scripts']) {
    const from = join(source, dir)
    if (existsSync(from)) cpSync(from, join(target, dir), { recursive: true, filter: copyFilter })
  }
  writeFileSync(join(target, VERSION_FILE), version + '\n', 'utf-8')

  return backup ? { action: 'updated', backup } : { action: 'installed' }
}

// ---------------------------------------------------------------- 6. launch script

/** POSIX single-quote: safe for any bytes including spaces, Hangul and quotes. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * `codex -c` 오버라이드 문자열 — ~/.codex/skills·~/.agents/skills 에 남은 전역
 * `knuaf-dev` 사본을 이 프로세스에서만 끈다. 같은 이름의 낡은 사본이 프로젝트 사본과
 * 함께 enabled 로 보이면 모델이 옛 지침을 따를 수 있다(~/.codex 는 deprecated 지만
 * 아직 스캔된다). 사용자의 config.toml 은 건드리지 않는다 — 오버라이드는 이 프로세스만.
 * 전역 사본이 없으면 null — 인자를 늘리지 않는다.
 */
export function codexSkillConfigOverride(home: string | undefined): string | null {
  if (!home) return null
  const paths = [SKILL_NAME, ...SUPERSEDED_SKILL_NAMES].flatMap((name) => [
    join(home, '.codex', 'skills', name, 'SKILL.md'),
    join(home, '.agents', 'skills', name, 'SKILL.md')
  ]).filter((p) => existsSync(p))
  if (paths.length === 0) return null
  const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `skills.config=[${paths.map((p) => `{path="${esc(p)}",enabled=false}`).join(',')}]`
}

// 터미널 한 줄이라 여기서는 ASCII 짧은 이름을 쓴다 — 긴 이름을 넣으면 "도우미가 AI
// 도우미를 엽니다" 가 되어 같은 말이 두 번 나온다.
export const BANNER = `${APP_NAME_SHORT} 가 AI 도우미를 엽니다. 이 창을 닫으면 도우미도 종료돼요.`

/** Directories an agent process needs ahead of PATH: project venv, bundled runtime, user installs. */
export function agentBinDirs(o: Pick<LaunchScriptOptions, 'venvBin' | 'bundledBin'>): string[] {
  const dirs: string[] = []
  if (o.venvBin) dirs.push(o.venvBin)
  if (o.bundledBin) dirs.push(o.bundledBin)
  dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  return dirs
}

export function buildLaunchScript(o: LaunchScriptOptions, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? buildLaunchScriptWin(o) : buildLaunchScriptPosix(o)
}

/** 실행물 확장자 — 맥·리눅스는 `.command`(Terminal 이 열어 준다), 윈도우는 `.cmd`. */
export function launchScriptExt(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? '.cmd' : '.command'
}

/** 배치 파일에서 `%` 는 변수 확장이다 — 글자 그대로 넣으려면 `%%` 로 적는다. */
function batLiteral(s: string): string {
  return s.replace(/%/g, '%%')
}
/** 배치의 `cd`·`set` 처럼 따옴표 **안에** 넣는 값 — `%` 만 `%%` 로 막으면 된다. */
function batQuote(s: string): string {
  return `"${batLiteral(s)}"`
}
/** 배치에서 cmd 메타문자 — `%` 는 `%%` 로 따로 막으므로 여기 없다(배치에서 `^%` 는 안 통한다). */
const BAT_META = /([()\][!^"`<>&|;, *?])/g

/**
 * 배치 shim의 **실행 파일 경로**. 명령 이름은 shim 의 `%*` 로 다시 해석되지 않으므로 **한 층**만
 * 막는다(`win.ts` 의 `escapeCommand` 와 같은 규칙 — `%` 는 배치 확장이라 `%%`).
 * 두 층으로 막으면 첫 cmd 해석 뒤에도 `^` 가 남아 실행 파일 이름을 찾지 못한다
 * (W1C-R1-01 확인. cross-spawn `parse.js` 도 명령에는 `escape.command` 만 쓴다).
 * 네이티브 실행물에는 쓰지 않는다. 공백을 ^로만 막으면 cmd가 실행물을 찾더라도 CRT가
 * 따옴표 없는 argv[0]을 공백에서 잘라 경로 뒷부분을 추가 인자로 만든다(Windows CI QA-04).
 */
function batCommand(s: string): string {
  return batLiteral(s).replace(BAT_META, '^$1')
}

/**
 * 배치 파일의 **실행 줄**에 넣을 인자 하나. 확장 단계가 명령줄과 달라 `win.ts` 의 함수를
 * 쓰지 않는다(W1C-R1-01). 순서가 중요하다:
 *   1. `%` → `%%` — 배치 확장은 여기서만 막을 수 있다.
 *   2. MSVCRT 인용 — `"` 앞과 끝의 역슬래시를 두 배로.
 *   3. cmd 메타문자를 `^` 로 — 대상이 npm shim(`claude.cmd`/`codex.cmd`)이면 **두 번**.
 *      shim 은 `%*` 로 한 번 더 파싱되기 때문이다(`win.ts` 주석의 cross-spawn 규칙과 같은 이유).
 *      대상이 `.exe`(설치본에 동봉한 `codex.exe`)면 **한 번**만 — cmd 가 한 번 읽고 바로
 *      MSVCRT 로 넘기므로, 두 번 막으면 `^` 가 인자에 남아 설정값이 깨진다(실기기 QA-04).
 */
function batArg(s: string, doubleEscape: boolean): string {
  let a = batLiteral(s)
  a = a.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  a = a.replace(/(?=(\\+?)?)\1$/, '$1$1')
  a = `"${a}"`
  a = a.replace(BAT_META, '^$1')
  if (doubleEscape) a = a.replace(BAT_META, '^$1')
  return a
}
/** 대상이 `%*` 로 인자를 다시 읽는 배치(npm shim)인지 — `win.ts` 의 `CMD_SHIM` 과 같은 규칙. */
function isBatchShim(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path)
}
/** cmd 인자는 **한 줄**이라야 한다 — 첫 프롬프트의 줄바꿈을 한 칸으로 눌러 담는다. */
function oneLine(s: string): string {
  return s.replace(/\s*\n+\s*/g, ' ').trim()
}

function buildLaunchScriptPosix(o: LaunchScriptOptions): string {
  const pathParts = agentBinDirs(o).map(sq)
  pathParts.push('"$HOME/.local/bin"', '"$PATH"')

  // 비상구(외부 터미널)에도 앱 채팅과 같은 가드레일을 둔다 — 프로젝트 스킬만 유효하게
  // (--setting-sources project,local / 전역 knuaf-dev 사본 비활성) 하고 도구 팝업
  // (AskUserQuestion)은 끈다. `--disallowedTools=…` 는 `=` 로 묶어야 한다 — 공백이면
  // 가변 인자가 뒤따르는 첫 프롬프트까지 삼킨다(7364349).
  const skillOff = o.agent === 'codex' ? codexSkillConfigOverride(o.home) : null
  const execLine = o.agent === 'claude'
    ? `exec ${sq(o.agentPath)} --setting-sources project,local '--disallowedTools=AskUserQuestion' ${sq(o.firstPrompt)}`
    : `exec ${sq(o.agentPath)}${skillOff ? ` -c ${sq(skillOff)}` : ''}` // codex: no positional prompt; the user types in the TUI

  return [
    '#!/bin/bash',
    `cd ${sq(o.root)} || exit 1`,
    `export PATH=${pathParts.join(':')}`,
    'export KNUAF_DOC_APP=1',
    // ~/.claude/CLAUDE.md 같은 사용자 메모리의 @import가 외부 경로를 가리키면 영어 보안
    // 프롬프트가 학생에게 뜬다 — 이 앱이 띄우는 도우미는 메모리 파일을 아예 읽지 않는다.
    'export CLAUDE_CODE_DISABLE_CLAUDE_MDS=1',
    `printf '%s\\n' ${sq(BANNER)}`,
    "printf '%s\\n' ''",
    execLine,
    ''
  ].join('\n')
}

/**
 * 윈도우 대응 실행물 — `.command`(bash) 대신 `.cmd`(배치)다. 같은 일을 한다: 작업 폴더로
 * 이동하고, 프로젝트 .venv·번들 파이썬 자리를 PATH 앞에 두고, 같은 환경변수를 세우고,
 * 같은 가드레일(`--setting-sources project,local` / 전역 knuaf-dev 사본 끄기)로 도우미를 띄운다.
 *
 * 다른 곳 둘: cmd 에는 `exec` 가 없고(그냥 실행한다), **한 인자에 줄바꿈을 담을 수 없다** —
 * 첫 프롬프트의 줄바꿈은 한 칸으로 눌러 한 줄로 만든다(문장 뜻은 그대로다).
 *
 * **코드페이지.** 파일은 UTF-8(BOM 없음)로 쓰는데 cmd 는 배치 줄을 콘솔 코드페이지(한국어
 * 윈도우는 949)로 읽는다. 그러면 한글 경로가 깨져 `cd` 가 "구문이 잘못되었습니다" 로 실패한다
 * (실기기 QA-04). cmd 는 배치를 **한 줄씩 다시 읽으므로** 둘째 줄에서 `chcp 65001` 로 바꾸면
 * 그 뒤 줄은 UTF-8 로 읽힌다 — 그래서 그 앞 두 줄은 ASCII 여야 한다.
 *
 * **실패하면 창을 남긴다.** 이동·실행이 실패하면 창이 바로 닫혀 학생은 이유를 못 본다 —
 * 오류가 나면 `pause` 로 멈춘다(정상 종료 0 이면 그냥 닫힌다). 다른 배치를 직접 실행하면
 * 제어가 돌아오지 않으므로 실행 부분은 자식 cmd 에 맡긴다. `call` 은 사용자 경로/인자를
 * 다시 확장하므로 쓰지 않는다. 부모 배치가 종료 코드를 보존하고 실패를 보여 준다.
 */
function buildLaunchScriptWin(o: LaunchScriptOptions): string {
  // 윈도우에는 홈브루 자리가 없다(agentBinDirs 의 그 둘은 맥 전용) — venv·번들만 앞에 둔다.
  const dirs = [o.venvBin, o.bundledBin].filter((d): d is string => !!d).map(batLiteral)
  const skillOff = o.agent === 'codex' ? codexSkillConfigOverride(o.home) : null
  const dbl = isBatchShim(o.agentPath)
  // .exe의 명령 이름은 argv[0]으로도 읽힌다. cmd escape 대신 경로 전체를 인용해야 한다.
  const command = dbl ? batCommand(o.agentPath) : batQuote(o.agentPath)
  const execLine = o.agent === 'claude'
    ? `${command} --setting-sources project,local ${batArg('--disallowedTools=AskUserQuestion', dbl)} ${batArg(oneLine(o.firstPrompt), dbl)}`
    : `${command}${skillOff ? ` -c ${batArg(skillOff, dbl)}` : ''}`

  return [
    '@echo off',
    // 이 줄까지는 ASCII 다 — 다음 줄부터 UTF-8 로 읽힌다(위 주석의 코드페이지).
    'chcp 65001 >nul',
    // 지연 확장을 끈다 — `!` 가 든 경로·문장이 글자 그대로 가게(레지스트리 설정과 무관하게).
    'setlocal DisableDelayedExpansion',
    'if "%~1"=="--knuaf-run" goto knuaf-run',
    // 자식은 같은 파일의 실행 절만 읽는다. 고정 인자 하나뿐이고 원문 프롬프트를 재확장하지 않는다.
    '"%ComSpec%" /d /v:off /s /c ""%~f0" --knuaf-run"',
    'set "KNUAF_LAUNCH_EXIT=%errorlevel%"',
    'if "%KNUAF_LAUNCH_EXIT%"=="0" exit /b 0',
    'echo.',
    'echo 도우미를 실행하지 못했거나 오류로 끝났어요. 위 오류 내용을 확인해 주세요. 종료 코드: %KNUAF_LAUNCH_EXIT%',
    'pause',
    'exit /b %KNUAF_LAUNCH_EXIT%',
    ':knuaf-run',
    `cd /d ${batQuote(o.root)} || exit /b 1`,
    `set "PATH=${dirs.join(';')}${dirs.length ? ';' : ''}%PATH%"`,
    'set "KNUAF_DOC_APP=1"',
    'set "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1"',
    `echo ${batLiteral(BANNER)}`,
    'echo.',
    execLine,
    'exit /b %errorlevel%',
    ''
  ].join('\r\n')
}

// ---------------------------------------------------------------- 7. launch

export function firstPromptFor(revision: number | null, root?: string): string {
  const base = revision === null || revision < 1 ? '시작하기' : '이어서 하기'
  // 루트를 명시해 모델이 하위 폴더(knuaf-work 등)를 추측해 만들지 않게 한다.
  return root ? `${base}\n\n작업 폴더: ${root}\n이 폴더 자체가 논문 작업 폴더예요. 하위 폴더를 새로 만들지 말고 여기서 바로 작업해 주세요.` : base
}

export async function launch(o: LaunchOptions, deps: LaunchDeps = {}): Promise<LaunchResult> {
  const writeFile = deps.writeFile ?? ((p, data, mode) => writeFileSync(p, data, { encoding: 'utf-8', mode }))
  const chmod = deps.chmod ?? chmodSync
  mkdirSync(o.supportDir, { recursive: true })
  const scriptPath = join(o.supportDir, `launch-${randomBytes(4).toString('hex')}${launchScriptExt()}`)
  writeFile(scriptPath, buildLaunchScript(o), 0o755)
  chmod(scriptPath, 0o755) // writeFile mode is masked by umask; make sure it is executable
  if (!o.dryRun) {
    if (!deps.open) throw new Error('launch: open() is required unless dryRun')
    const err = await deps.open(scriptPath)
    if (err) throw new Error('터미널을 열지 못함: ' + err)
  }
  return { scriptPath }
}

// ---------------------------------------------------------------- 8. composed API

/** `root` is the open project; with no project open the skill reports 'missing'. */
export async function getStatus(ctx: AgentCtx, root: string | null): Promise<AgentStatus> {
  const env = ctx.env ?? process.env
  const leadingDirs = bundledAgentDirs(ctx)
  const probe = async (name: AgentKind): Promise<AgentBinary> => {
    const path = findExecutable(name, env, { leadingDirs })
    return { found: !!path, path, version: path ? await probeVersion(path) : null }
  }
  const [claude, codex] = await Promise.all([probe('claude'), probe('codex')])
  const version = skillVersion(skillSource(ctx.appRoot, ctx.isPackaged, ctx.resourcesPath))
  const targets = root ? skillTargets(root) : null
  return {
    claude,
    codex,
    skill: {
      claude: targets ? skillState(targets.claude, version) : 'missing',
      codex: targets ? skillState(targets.codex, version) : 'missing'
    },
    skillVersion: version
  }
}

export const agentApi = {
  status: (ctx: AgentCtx, root: string | null): Promise<AgentStatus> => getStatus(ctx, root),

  installSkill: (ctx: AgentCtx, kind: AgentKind, root: string | null): InstallResult => {
    if (!root) throw new Error('먼저 작업 폴더를 열어 주세요.')
    const source = skillSource(ctx.appRoot, ctx.isPackaged, ctx.resourcesPath)
    return installSkill(source, skillTargets(root)[kind], skillVersion(source))
  },

  launch: (ctx: AgentCtx, o: { root: string; kind: AgentKind; revision: number | null }): Promise<LaunchResult> => {
    const agentPath = findExecutable(o.kind, ctx.env ?? process.env, { leadingDirs: bundledAgentDirs(ctx) })
    if (!agentPath) throw new Error(`${o.kind} 실행 파일을 찾지 못함 (PATH에 없음)`)
    const venv = ctx.venvPython(o.root)
    const bundled = ctx.bundledPython?.() ?? null
    return launch({
      root: o.root,
      agent: o.kind,
      agentPath,
      venvBin: venv ? dirname(venv) : null,
      bundledBin: bundled ? dirname(bundled) : null,
      firstPrompt: firstPromptFor(o.revision, o.root),
      home: ctx.home,
      supportDir: ctx.supportDir,
      dryRun: ctx.dryRun
    }, { open: ctx.open })
  }
}
