/**
 * AI agent (Claude Code / Codex CLI) discovery, skill installation and terminal launch.
 *
 * Deliberately free of `electron` imports: every environment-specific value (home dir, app root,
 * packaged state, `shell.openPath`, venv lookup) is passed in through `AgentCtx`, so the module can be
 * unit-tested from plain Node (see e2e/agent.spec.ts). ipc.ts wires `agentApi` to IPC handlers.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { accessSync, chmodSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { APP_NAME_SHORT } from '../shared/name'

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

/** First executable named `name` on env.PATH, then in the usual user-install dirs. Absolute path or null. */
export function findExecutable(name: string, env: Record<string, string | undefined> = process.env): string | null {
  const home = env.HOME ?? env.USERPROFILE ?? ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const fromPath = (env.PATH ?? '').split(sep).filter(Boolean)
  const dirs = [...fromPath, ...EXTRA_DIRS(home)]
  const names = process.platform === 'win32' ? [name, `${name}.cmd`, `${name}.exe`] : [name]
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

/** `<path> --version`, trimmed first line; null on failure or after 8s. */
export function probeVersion(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(path, ['--version'], { timeout: 8000, encoding: 'utf-8', windowsHide: true }, (err, stdout) => {
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
    renameSync(old, dest)
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
    renameSync(target, backup)
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

export function buildLaunchScript(o: LaunchScriptOptions): string {
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
  const scriptPath = join(o.supportDir, `launch-${randomBytes(4).toString('hex')}.command`)
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
  const probe = async (name: AgentKind): Promise<AgentBinary> => {
    const path = findExecutable(name, env)
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
    const agentPath = findExecutable(o.kind, ctx.env ?? process.env)
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
