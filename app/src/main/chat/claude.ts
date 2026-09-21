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
/**
 * 폴더 안에 머무르지 않는 도구들. 경로 인자가 전부 폴더 안이어도 **폴더 밖 효과**를 낸다 —
 * 네트워크로 내보내거나, 다른 앱을 몰거나, 권한·설치를 건드린다.
 *
 * 앱의 경계는 "논문 폴더 안" 하나다. 네트워크는 그 경계 밖에서도 가장 바깥이라
 * 여기 둔다. 목록에 없는 평범한 도구는 경로만 폴더 안이면 묻지 않는다.
 */
const OUTSIDE_REACH = new Set([
  'curl', 'wget', 'nc', 'ncat', 'socat', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet',
  'sudo', 'su', 'doas', 'chmod', 'chown', 'chgrp', 'launchctl', 'defaults', 'osascript',
  'open', 'npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3', 'brew', 'git', 'crontab', 'killall'
])
/**
 * 앱이 읽을 수 없는 프로그램을 돌리는 것들. 파일 하나만 넘겨도 그 안에 무엇이 있는지
 * 앱은 모른다 — 스킬이 실제로 돌리는 스크립트만 통과시킨다.
 */
const INTERPRETERS = /^(python3?(\.\d+)?|sh|bash|zsh|node|perl|ruby)$/
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

/**
 * 이 조각을 묻지 않고 통과시켜도 되는가.
 *
 * 예전에는 아홉 개짜리 읽기 전용 목록이었다. 그래서 `shasum <폴더 안 파일>`,
 * `find <폴더 안>`, `mkdir -p <폴더 안>` 같은 것이 전부 승인 창을 띄웠고,
 * 시험주행에서는 메시지 여덟 개 도는 동안 카드가 여섯 번 떴다. 전부 폴더 안 일이었다.
 *
 * 읽지도 못할 것을 반복해서 클릭하게 만들면 그건 보호가 아니라 습관적 승인을 기르는
 * 일이다. 그래서 파일 도구에 이미 적용하던 선을 셸에도 같게 적용한다 —
 * **경로가 전부 논문 폴더 안이면 묻지 않는다.** 폴더 밖으로 나가는 도구와 앱이 읽을 수
 * 없는 프로그램만 계속 묻는다.
 */
function safeSegment(root: string, seg: string): boolean {
  const t = tokens(seg)
  if (!t.length) return false
  const [exe, ...args] = t
  const base = exe.split('/').pop() ?? exe
  if (INTERPRETERS.test(base)) {
    if (args.some((a) => a === '-c' || a === '-m' || a === '-e')) return false // 인라인 코드
    const script = args.find((a) => !a.startsWith('-'))
    if (!script) return argsInRoot(root, args)                   // python3 --version 같은 조회
    return SKILL_SCRIPT.test(script) && argsInRoot(root, args)
  }
  if (OUTSIDE_REACH.has(base)) return false
  return argsInRoot(root, args)
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

/**
 * 승인 통로가 이미 닫힌 뒤에 들어온 도구 호출의 흔적.
 *
 * SDK 는 문자열 prompt 를 단일 턴으로 보고 첫 `result` 에서 CLI 의 stdin 을 닫는다.
 * 그 뒤의 쓰기 계열 호출은 요청이 전송되기도 전에 죽어 `canUseTool` 이 불리지 않고,
 * 앱은 승인 창을 띄울 기회조차 없다. 학생 화면에는 아무 일도 없었던 것처럼 보이고
 * 도우미만 "쓰기 권한이 차단됐다"고 말한다(시험주행 발견 11).
 *
 * 막을 수는 없어도 **말할 수는 있다.** 실패한 도구 결과는 앱이 이미 읽고 있는
 * 메시지 스트림에 그대로 흘러오므로 여기서 집어 낸다.
 */
const PERMISSION_LOST = /Tool permission request failed/i

/** 이 메시지에 "승인 통로가 닫혀 죽은 도구 호출"이 몇 건 들어 있는가. */
/** SDK 가 받는 추론 강도. 알 수 없는 값은 조용히 무시한다 — 오타로 세션이 죽지 않게. */
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

export function lostToolCalls(message: unknown): number {
  const content = (message as { message?: { content?: unknown } })?.message?.content
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const block of content) {
    const b = block as { type?: unknown; is_error?: unknown; content?: unknown }
    if (b?.type !== 'tool_result' || b.is_error !== true) continue
    const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
    if (PERMISSION_LOST.test(body)) n++
  }
  return n
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
    // 여기까지 왔다는 것은 autoAllow 가 통과시키지 않았다는 뜻이다. 이유를 사실대로
    // 나눠 말한다 — 예전에는 무엇에 걸렸든 "경로는 모두 논문 폴더 안이에요"라고 단정해서,
    // 경로 인자가 하나도 없는 명령(`command -v …`)에도 그렇게 적혔다(시험주행 발견 6).
    const segs = cmd.split(/\s*(?:\|\||&&|;|\|)\s*/).map((x) => x.trim()).filter(Boolean)
    const reach = segs.map((x) => (tokens(x)[0] ?? '').split('/').pop() ?? '').find((b) => OUTSIDE_REACH.has(b))
    if (reach) return { title: '논문 폴더 밖으로 나가는 명령이에요', detail: `${cmd}\n\n"${reach}" 는 네트워크·다른 앱·설치처럼 폴더 밖에 닿아요. 의도한 일이 아니면 거절해 주세요.` }
    const interp = segs.find((x) => INTERPRETERS.test((tokens(x)[0] ?? '').split('/').pop() ?? ''))
    if (interp) return { title: '앱이 읽을 수 없는 프로그램을 실행해요', detail: `${cmd}\n\n프로그램 안에 무엇이 있는지 앱이 미리 알 수 없어요. 무슨 일인지 모르겠으면 거절해 주세요.` }
    return { title: '컴퓨터에서 명령을 실행하려고 해요', detail: `${cmd}\n\n앱이 폴더 안 일이라고 확인하지 못한 명령이에요. 무슨 일인지 모르겠으면 거절해 주세요.` }
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
    const q = this.active = query({ prompt: sessionId ? text : `/knuaf-dev ${text}\n\n작업 폴더: ${this.options.root}\n이 폴더 자체가 논문 작업 폴더예요. 하위 폴더를 새로 만들지 말고 여기서 바로 작업해 주세요.`, options: {
      cwd: this.options.root, pathToClaudeCodeExecutable: this.options.binary,
      // The project's own skill copy stays authoritative — a stale ~/.claude/skills
      // cannot shadow or mix with it. The external .command launcher pins the same
      // scope (buildLaunchScript in ../agent.ts).
      env: this.options.env, settingSources: ['project', 'local'],
      resume: sessionId, abortController: this.controller, permissionMode: 'default',
      // 모델·추론 강도 핀. 미설정이면 CLI 기본값을 그대로 쓴다 — 학생 설정을 덮지 않는다.
      // (live 스펙이 sonnet 으로 비용을 낮추는 데도 같은 통로를 쓴다.)
      ...(this.options.env.KNUAF_CLAUDE_MODEL ? { model: this.options.env.KNUAF_CLAUDE_MODEL } : {}),
      ...(CLAUDE_EFFORTS.has(this.options.env.KNUAF_CLAUDE_EFFORT ?? '')
        ? { effort: this.options.env.KNUAF_CLAUDE_EFFORT as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: '이 세션은 개인용 knuaf-dev GUI입니다. knuaf-dev 스킬과 참조 지침을 그대로 따르세요. 질문과 답변은 채팅 텍스트로 유지하고 인터뷰 원문과 해석을 스킬의 로그 계약대로 기록하세요. 셸 명령은 앱이 그대로 읽고 판단할 수 있어야 자동으로 통과합니다. 변수 대입($PY=… 같은)·$PWD 같은 변수 참조·`…`·$(…)·서브셸·리다이렉트를 쓰지 말고, 경로는 따옴표로 감싼 절대경로를 그대로 적으세요. 그러지 않으면 학생에게 읽을 수 없는 승인 창이 뜹니다. 셸에 프로그램을 밀어 넣지 마세요(heredoc·python -c 등). 엑셀·문서 읽기는 스킬의 스크립트에 이미 있으니 그것을 쓰세요. 서브에이전트를 백그라운드로 띄우지 마세요(run_in_background 금지). 턴이 끝난 뒤에 도구를 쓰면 승인 통로가 이미 닫혀 있어 그 작업은 반드시 실패합니다.' },
      // 백그라운드 서브에이전트를 막는 것은 취향이 아니다. SDK 는 문자열 prompt 를 단일
      // 턴으로 보고 첫 result 에서 CLI 의 stdin 을 닫는다(sdk.mjs: isSingleUserTurn).
      // 그 뒤에 오는 쓰기 계열 호출은 승인 요청이 전송되기도 전에
      // "AbortError: Stream closed" 로 죽고, canUseTool 은 호출조차 되지 않는다 —
      // 앱은 승인 창을 띄울 기회조차 없고 도우미는 그것을 "쓰기 권한 차단"으로 읽는다
      // (시험주행 발견 11, 재현으로 확인). 제대로 된 해법은 세션 동안 stdin 을 열어 두는
      // 스트리밍 입력이며 연결 수명 구조를 바꿔야 한다. 그때까지는 말로 막는다.
      canUseTool: async (name, input, options): Promise<PermissionResult> => {
        if (name === 'AskUserQuestion') return { behavior: 'deny', message: 'knuaf-dev 인터뷰 지침에 따라 질문을 채팅 텍스트로 제시하세요.' }
        // 작업폴더 안에서 하는 일은 학생이 이미 요청한 일이다 — 그 폴더를 직접 골라
        // "여기에 논문을 써 달라"고 한 것이 동의다. Codex 는 sandbox: 'workspace-write'
        // 로 같은 선을 이미 긋고 있고(codex.ts), 앱도 file:read/save-as 를 insideRoot 로,
        // 사이드카도 _confine() 으로 같은 선을 긋는다. Claude 만 예외였다.
        //
        // 매번 묻는 것은 동의를 구하는 게 아니라 읽지도 못할 것을 클릭하게 만드는 일이고,
        // 그러면 정작 폴더 밖을 건드리는 순간에도 습관적으로 허용을 누르게 된다.
        if (this.autoAllowed(name, input)) return { behavior: 'allow', updatedInput: input }
        // 여기서 통과하는 두 경우가 있다. (1) 설정의 "도우미가 도구를 쓸 때 물어볼까요?"
        // 가 기본값 '묻지 않기'다 — 그러면 폴더를 가리지 않고 통과한다. (2) 학생이 권한
        // 카드에서 "이 폴더에서는 계속 허용"을 직접 눌렀다.
        //
        // 기본을 묻지 않기로 둔 것은 편의를 위한 결정이고, 무엇을 포기하는지는 설정
        // 화면에 그대로 적혀 있다(도우미는 폴더 밖 PDF·웹 문서도 읽고, 그 안에 섞인
        // 지시를 앱이 걸러 주지 않는다). 물어보기로 되돌리면 위의 autoAllow 가 폴더 안
        // 일을 걸러 주므로, 그때 남는 질문은 폴더 밖·읽을 수 없는 명령뿐이다.
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
      if (!commands.some(c => c.name === 'knuaf-dev' || c.name.endsWith(':knuaf-dev'))) throw new Error('Claude가 knuaf-dev 스킬을 찾지 못했어요.')
      events.skill()
      const account = await q.accountInfo()
      if (account.apiKeySource && account.apiKeySource !== 'none') throw new Error('API 인증이 감지되어 중단했어요. 구독 인증을 확인해 주세요.')
      let lost = 0
      for await (const message of q) {
        if ('session_id' in message && message.session_id) events.session(message.session_id)
        lost += lostToolCalls(message)
        if (message.type === 'assistant') {
          const text = message.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          if (text) events.message(message.uuid, text)
        }
        if (message.type === 'result' && message.is_error) throw new Error('Claude 작업이 완료되지 않았어요. 연결·사용 한도와 마지막 대화를 확인해 주세요.')
      }
      // 턴이 성공으로 끝나도 그 안에서 조용히 죽은 작업이 있으면 그대로 말한다.
      // 이걸 안 하면 도우미의 마무리 인사만 남고 실패는 아무 데도 안 보인다.
      if (lost > 0) events.note(`도우미가 이번 작업 중에 파일 ${lost}건을 저장하지 못했어요. 앱이 승인 창을 띄우기 전에 통로가 닫혀서, 그 저장은 일어나지 않았어요. 필요하면 다시 요청해 주세요.`)
    } finally {
      q.close(); this.active = undefined
      // 답을 기다리던 요청은 거절로 닫고 지운다. 그냥 지우면 canUseTool 의 promise 가
      // 영영 안 풀려 그 도구 호출이 매달린 채 남는다.
      for (const answer of [...this.approvals.values()]) answer(false)
      this.approvals.clear()
    }
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
