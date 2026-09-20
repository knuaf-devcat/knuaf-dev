import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { query, type Query, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentConnection, AgentEvents, AgentOptions } from './contracts'

/** 작업폴더 밖을 가리키면 null이 아닌 그 경로를 돌려준다(묻는 이유를 문장으로 쓰기 위해). */
function outsideRoot(root: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const base = resolve(root)
  const abs = resolve(base, value)
  // 한글 경로는 두 가지 형태로 온다. macOS 파일시스템(따라서 앱이 쥔 root)은 NFD 로
  // 분해해 주고, 모델이 답변 텍스트에 써 보낸 경로는 NFC 다. 정규화 없이 문자열로
  // 비교하면 폴더 안의 파일이 "밖"으로 판정된다 — dmg 서명 봉인이 깨진 것과 같은 원인.
  const n = (x: string) => x.normalize('NFC')
  return n(abs) === n(base) || n(abs).startsWith(n(base) + sep) ? null : abs
}

/** 경로를 인자로 받는 도구들. 여기 없는 도구는 자동 허용 대상이 아니다. */
const PATH_TOOLS: Record<string, string[]> = {
  Write: ['file_path'], Edit: ['file_path'], MultiEdit: ['file_path'],
  Read: ['file_path'], NotebookEdit: ['notebook_path'],
  Glob: ['path'], Grep: ['path'], LS: ['path']
}

/**
 * 셸은 정적으로 가둘 수 없다 — Codex 의 workspace-write 는 OS 샌드박스지만 여기는 아니다.
 * 그래서 샌드박스를 흉내 내지 않고 **좁은 허용 목록**만 둔다: 명령을 이어붙이기 기호로
 * 쪼개어 모든 조각이 (작업폴더 안 gg 계열 스크립트 실행) 또는 (읽기만 하는 도구)일 때만
 * 통과시키고, 한 조각이라도 모르는 것이면 전체를 묻는다.
 *
 * 매번 묻는 쪽이 더 안전해 보이지만 아니다. 학생은 셸 파이프라인을 읽고 판단할 수 없어
 * 결국 늘 "허용"을 누르게 되고, 그러면 정작 위험한 명령에도 그냥 누른다. 경고가 의미를
 * 가지려면 드물어야 한다.
 */
const BENIGN_REDIR = /\s*(?:2>&1|&?>\s*\/dev\/null|2>\s*\/dev\/null)/g
/**
 * 치환·서브셸·리다이렉트·변수가 남아 있으면 조각 단위로 판정할 수 없다.
 *
 * `$` 를 통째로 막는 게 핵심이다. 값을 모르는 채 문자 그대로 보면
 * `cat "$HOME/.ssh/id_rsa"` 가 루트 기준 상대경로로 읽혀 "폴더 안"으로 판정되고,
 * 실행 시점에는 진짜 홈으로 펼쳐진다. 변수를 추적하려면 셸 인터프리터를 써야 하므로
 * 추적하지 않고 묻는다 — 대신 두 공급자 지시문이 변수를 쓰지 말라고 일러둔다.
 *
 * `~` 도 같은 부류인데 처음엔 빠져 있었다. `$HOME` 만 막고 `~` 를 놔두면
 * `cat ~/.ssh/id_rsa` 가 resolve(root, "~/.ssh/id_rsa") = root + "/~/.ssh/id_rsa" 로
 * 접혀 "폴더 안"이 되고, cat 은 읽기 전용 목록에 있으므로 묻지도 않고 통과했다.
 * 펼침은 셸이 하고 판정은 앱이 하니, 펼쳐지는 기호는 전부 판정 불가로 둔다.
 */
const SHELL_UNJUDGEABLE = /[`<>(){}$~]/
/** 읽기만 하는 도구. 경로 인자는 전부 작업폴더 안이어야 한다. */
const READ_ONLY = new Set(['cd', 'ls', 'echo', 'head', 'tail', 'cat', 'pwd', 'wc', 'true'])
/** 스킬이 실제로 돌리는 스크립트들. */
const SKILL_SCRIPT = /(^|\/)(gg|gg_[a-z_]+|build_docx|show_research|merge_sections|build_status|lint_[a-z_]+)\.py$/

/** 따옴표를 존중하는 최소 토크나이저. 이스케이프는 다루지 않는다(있으면 어차피 거절된다). */
function tokens(seg: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** 경로처럼 생긴 인자는 전부 작업폴더 안이어야 한다. 플래그와 평범한 낱말은 통과. */
function argsInRoot(root: string, args: string[]): boolean {
  return args.every((a) => a.startsWith('-') || !(a.includes('/') || a === '.' || a === '..') || outsideRoot(root, a) === null)
}

function safeSegment(root: string, seg: string): boolean {
  const t = tokens(seg)
  if (!t.length) return false
  const [exe, ...args] = t
  const base = exe.split('/').pop() ?? exe
  if (/^python3?(\.\d+)?$/.test(base)) {
    if (args.includes('-c') || args.includes('-m')) return false // 인라인 코드·모듈 실행
    const script = args.find((a) => !a.startsWith('-'))
    if (!script) return argsInRoot(root, args)                   // python3 --version 같은 조회
    return SKILL_SCRIPT.test(script) && argsInRoot(root, args)
  }
  return READ_ONLY.has(base) && argsInRoot(root, args)
}

function isSkillCommand(root: string, input: unknown): boolean {
  const raw = (input as { command?: unknown })?.command
  if (typeof raw !== 'string' || !raw.trim()) return false
  const cmd = raw.replace(BENIGN_REDIR, ' ')
  if (SHELL_UNJUDGEABLE.test(cmd) || /\n/.test(cmd)) return false
  const segs = cmd.split(/\s*(?:\|\||&&|;|\|)\s*/).map((x) => x.trim()).filter(Boolean)
  return segs.length > 0 && segs.every((x) => safeSegment(root, x))
}

/**
 * Bash 명령의 인자 중 작업폴더 밖을 가리키는 경로만 모은다. 판정 자체가 불가능하면 null.
 *
 * isSkillCommand 와 규칙은 같지만 묻는 것이 다르다. 저쪽은 "통과시킬까",
 * 이쪽은 "학생에게 뭐라고 말할까"다. 이게 없으면 PATH_TOOLS 에 Bash 가 없는 탓에
 * 폴더 밖 파일을 읽는 명령에도 "논문 폴더 안에서 도구를 돌리는 명령이면 허용해도 돼요"가
 * 붙는다. 물어본 이유와 정반대를 읽은 학생은 그대로 허용을 누르고, 그 옆이
 * "이 폴더에서는 계속 허용"이라 한 번의 오독이 폴더 전체 신뢰로 굳는다.
 */
function bashOutside(root: string, raw: string): string[] | null {
  const cmd = raw.replace(BENIGN_REDIR, ' ')
  if (SHELL_UNJUDGEABLE.test(cmd) || /\n/.test(cmd)) return null
  const out: string[] = []
  for (const seg of cmd.split(/\s*(?:\|\||&&|;|\|)\s*/)) {
    // 실행 파일 자체(/usr/bin/grep 등)는 뺀다 — argsInRoot 와 같은 범위.
    for (const a of tokens(seg).slice(1)) {
      if (a.startsWith('-') || !(a.includes('/') || a === '.' || a === '..')) continue
      const o = outsideRoot(root, a)
      if (o && !out.includes(o)) out.push(o)
    }
  }
  return out
}

/** 원시 JSON 대신 학생이 읽을 수 있는 한 문장. 자세한 값은 그대로 덧붙인다. */
function describeTool(name: string, input: unknown, root: string): { title: string; detail: string } {
  const keys = PATH_TOOLS[name] ?? []
  const outside = keys.map((k) => outsideRoot(root, (input as Record<string, unknown>)[k])).find(Boolean)
  if (outside) return { title: '논문 폴더 밖의 파일을 건드리려고 해요', detail: `대상: ${outside}\n\n논문 폴더 안이 아니에요. 의도한 일이 아니면 거절해 주세요.` }
  const cmd = (input as { command?: unknown })?.command
  if (name === 'Bash' && typeof cmd === 'string') {
    const out = bashOutside(root, cmd)
    if (out === null) return { title: '앱이 읽을 수 없는 명령이에요', detail: `${cmd}\n\n변수나 기호가 섞여 있어 무엇을 건드릴지 앱이 미리 알 수 없어요. 무슨 일인지 모르겠으면 거절해 주세요.` }
    if (out.length) return { title: '논문 폴더 밖의 파일을 건드리려고 해요', detail: `${cmd}\n\n폴더 밖: ${out.join(', ')}\n\n논문 폴더 안이 아니에요. 의도한 일이 아니면 거절해 주세요.` }
    return { title: '컴퓨터에서 명령을 실행하려고 해요', detail: `${cmd}\n\n경로는 모두 논문 폴더 안이에요. 앱이 아는 도구가 아니라서 여쭤봐요.` }
  }
  return { title: `도우미가 "${name}" 도구를 쓰려고 해요`, detail: JSON.stringify(input, null, 2) }
}

/** 자동 허용 판정 — 클래스 밖 순수 함수로 두어 테스트가 직접 고정한다(권한 경계). */
export function autoAllow(root: string, name: string, input: unknown, allowed: string[] = []): boolean {
  const ok = (v: unknown) => outsideRoot(root, v) === null || (typeof v === 'string' && allowed.includes(realOrSelf(resolve(root, v)).normalize('NFC')))
  const keys = PATH_TOOLS[name]
  if (keys) return keys.every((k) => ok((input as Record<string, unknown>)[k]))
  if (name === 'Bash') return isSkillCommand(root, input)
  return false
}

/**
 * project.json 에 등록된 출처 파일은 폴더 밖이어도 학생이 직접 이름을 댄 파일이다
 * (재무 엑셀·학교 지침 PDF 등). 학생이 알려준 파일을 읽는 것까지 묻지는 않는다.
 * 읽기 전용 판정이 아니라 "이 경로는 안다"는 뜻이므로, 셸 실행에는 적용하지 않는다.
 */
export function registeredSources(root: string): string[] {
  try {
    const p = JSON.parse(readFileSync(join(root, 'project.json'), 'utf-8')) as { sources?: Record<string, { path?: unknown }> }
    return Object.values(p.sources ?? {})
      .map((s) => (typeof s?.path === 'string' ? realOrSelf(resolve(root, s.path)).normalize('NFC') : null))
      .filter((x): x is string => !!x)
  } catch { return [] }
}

function realOrSelf(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

export { describeTool }

export class ClaudeConnection implements AgentConnection {
  private active?: Query
  private loginProcess?: ChildProcess
  private controller?: AbortController
  private approvals = new Map<string, (allow: boolean) => void>()
  constructor(private options: AgentOptions) {}
  private autoAllowed(name: string, input: unknown): boolean {
    return autoAllow(this.options.root, name, input, registeredSources(this.options.root))
  }
  async status() {
    let output = ''
    try { output = (await promisify(execFile)(this.options.binary, ['auth', 'status'], { env: this.options.env, timeout: 12_000 })).stdout }
    catch (e) { output = (e as { stdout?: string }).stdout ?? '{}' }
    let r: any = {}; try { r = JSON.parse(output) } catch { /* unknown authentication => disconnected */ }
    const connected = r.loggedIn === true && r.authMethod === 'claude.ai' && r.apiProvider === 'firstParty'
    return { installed: true, connected, version: null, detail: connected ? '' : 'Claude 구독 계정 로그인이 필요해요. 개인용 검증만 지원하며 API로 자동 전환하지 않아요.' }
  }
  async login() {
    if (this.loginProcess) throw new Error('브라우저에서 진행 중인 로그인을 완료해 주세요.')
    // Official CLI owns credential storage and prints an auth URL — surface it in the
    // student's browser instead of letting it die on a pipe nobody reads.
    const child = this.loginProcess = spawn(this.options.binary, ['auth', 'login', '--claudeai'], { env: this.options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    let opened = false
    const onData = (d: Buffer) => {
      if (opened) return
      buf += d.toString()
      const m = /https:\/\/\S+/.exec(buf)
      if (m) { opened = true; void this.options.openExternal(m[0].replace(/[)\].,;]+$/, '')) }
    }
    child.stdout?.on('data', onData); child.stderr?.on('data', onData)
    child.on('error', () => { this.loginProcess = undefined })
    child.on('close', () => { this.loginProcess = undefined })
    const timer = setTimeout(() => child.kill(), 180_000)
    timer.unref(); child.once('close', () => clearTimeout(timer))
  }
  async run(text: string, sessionId: string | undefined, events: AgentEvents) {
    if (!(await this.status()).connected) throw new Error('Claude 구독 계정 로그인을 완료해 주세요.')
    this.controller = new AbortController()
    // 첫 프롬프트에 작업 루트를 명시 — 모델이 하위 폴더를 추측해 만들지 않게.
    const q = this.active = query({ prompt: sessionId ? text : `/knuaf-doc ${text}\n\n작업 폴더: ${this.options.root}\n이 폴더 자체가 논문 작업 폴더예요. 하위 폴더를 새로 만들지 말고 여기서 바로 작업해 주세요.`, options: {
      cwd: this.options.root, pathToClaudeCodeExecutable: this.options.binary,
      // The project's own skill copy stays authoritative — a stale ~/.claude/skills
      // cannot shadow or mix with it. The external .command launcher pins the same
      // scope (buildLaunchScript in ../agent.ts).
      env: this.options.env, settingSources: ['project', 'local'],
      resume: sessionId, abortController: this.controller, permissionMode: 'default',
      // 테스트 전용 모델 핀(live 스펙이 sonnet 으로 비용을 낮춘다). 미설정이면 기본.
      ...(this.options.env.KNUAF_CLAUDE_MODEL ? { model: this.options.env.KNUAF_CLAUDE_MODEL } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: '이 세션은 개인용 knuaf-doc GUI입니다. knuaf-doc 스킬과 참조 지침을 그대로 따르세요. 질문과 답변은 채팅 텍스트로 유지하고 인터뷰 원문과 해석을 스킬의 로그 계약대로 기록하세요. 셸 명령은 앱이 그대로 읽고 판단할 수 있어야 자동으로 통과합니다. 변수 대입($PY=… 같은)·$PWD 같은 변수 참조·`…`·$(…)·서브셸·리다이렉트를 쓰지 말고, 경로는 따옴표로 감싼 절대경로를 그대로 적으세요. 그러지 않으면 학생에게 읽을 수 없는 승인 창이 뜹니다. 셸에 프로그램을 밀어 넣지 마세요(heredoc·python -c 등). 엑셀·문서 읽기는 스킬의 스크립트에 이미 있으니 그것을 쓰세요.' },
      canUseTool: async (name, input, options): Promise<PermissionResult> => {
        if (name === 'AskUserQuestion') return { behavior: 'deny', message: 'knuaf-doc 인터뷰 지침에 따라 질문을 채팅 텍스트로 제시하세요.' }
        // 작업폴더 안에서 하는 일은 학생이 이미 요청한 일이다 — 그 폴더를 직접 골라
        // "여기에 논문을 써 달라"고 한 것이 동의다. Codex 는 sandbox: 'workspace-write'
        // 로 같은 선을 이미 긋고 있고(codex.ts), 앱도 file:read/save-as 를 insideRoot 로,
        // 사이드카도 _confine() 으로 같은 선을 긋는다. Claude 만 예외였다.
        //
        // 매번 묻는 것은 동의를 구하는 게 아니라 읽지도 못할 것을 클릭하게 만드는 일이고,
        // 그러면 정작 폴더 밖을 건드리는 순간에도 습관적으로 허용을 누르게 된다.
        if (this.autoAllowed(name, input)) return { behavior: 'allow', updatedInput: input }
        // 학생이 이 폴더를 신뢰하기로 했으면 더 묻지 않는다. heredoc 으로 밀어 넣는
        // 프로그램처럼 판정 자체가 불가능한 것이 있어, 읽을 수 없는 것을 반복해서 묻는
        // 대신 폴더 단위로 한 번 정하게 한다(설정에서 되돌릴 수 있다).
        if (this.options.trusted?.()) return { behavior: 'allow', updatedInput: input }
        const id = randomUUID()
        const allowed = await new Promise<boolean>(resolve => {
          const done = (v: boolean) => { options.signal.removeEventListener('abort', aborted); this.approvals.delete(id); resolve(v) }
          const aborted = () => done(false)
          this.approvals.set(id, done)
          options.signal.addEventListener('abort', aborted, { once: true })
          events.permission({ id, ...describeTool(name, input, this.options.root) })
        })
        return allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: '사용자가 허용하지 않았습니다.' }
      }
    } })
    try {
      const commands = await q.supportedCommands()
      if (!commands.some(c => c.name === 'knuaf-doc' || c.name.endsWith(':knuaf-doc'))) throw new Error('Claude가 knuaf-doc 스킬을 찾지 못했어요.')
      events.skill()
      const account = await q.accountInfo()
      if (account.apiKeySource && account.apiKeySource !== 'none') throw new Error('API 인증이 감지되어 중단했어요. 구독 인증을 확인해 주세요.')
      for await (const message of q) {
        if ('session_id' in message && message.session_id) events.session(message.session_id)
        if (message.type === 'assistant') {
          const text = message.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          if (text) events.message(message.uuid, text)
        }
        if (message.type === 'result' && message.is_error) throw new Error('Claude 작업이 완료되지 않았어요. 연결·사용 한도와 마지막 대화를 확인해 주세요.')
      }
    } finally { q.close(); this.active = undefined; this.approvals.clear() }
  }
  respond(id: string, allow: boolean) {
    const answer = this.approvals.get(id)
    if (!answer) throw new Error('이미 종료된 권한 요청이에요.')
    answer(allow)
  }
  async stop() {
    for (const answer of this.approvals.values()) answer(false)
    this.controller?.abort(); this.active?.close(); this.loginProcess?.kill()
  }
}
