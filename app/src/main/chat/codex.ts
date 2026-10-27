import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { JsonRpcProcess } from './transport'
import { codexSkillConfigOverride } from '../agent'
import type { AgentConnection, AgentEvents, AgentOptions } from './contracts'
import type { ChatModelInfo } from '../../shared/chat'

/** 존재하면 realpath, 아니면 입력 그대로. 경로 비교는 반드시 이것을 거친다. */
export function realOrSelf(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/**
 * `codex app-server` argv. `-c 'skills.config=…'`(전역 knuaf-dev 사본 끄기)는 subcommand
 * 앞에 온다 — codex 의 config 오버라이드는 루트 인자다. 존재하는 사본이 없으면 순수
 * `['app-server']`. 단위 테스트가 이 모양을 고정한다(e2e/agent.spec.ts).
 */
export function serverArgsFor(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = []
  const cfg = codexSkillConfigOverride(env.HOME)
  if (cfg) args.push('-c', cfg)
  // 모델·추론 강도도 같은 방식으로 이 프로세스에서만 정한다. 값이 없으면 인자를 늘리지
  // 않고 CLI 기본값(학생의 config.toml)을 그대로 쓴다.
  if (env.KNUAF_CODEX_MODEL) args.push('-c', `model=${env.KNUAF_CODEX_MODEL}`)
  if (env.KNUAF_CODEX_EFFORT) args.push('-c', `model_reasoning_effort=${env.KNUAF_CODEX_EFFORT}`)
  return [...args, 'app-server']
}

export class CodexConnection implements AgentConnection {
  private rpc?: JsonRpcProcess
  private events?: AgentEvents
  private serverVersion: string | null = null
  private thread?: string
  private turn?: string
  /**
   * 이 연결이 **이 대화에** model/effort 덮어쓰기를 보낸 적이 있는가.
   * `turn/start` 의 model/effort 는 같은 thread 의 뒤 턴에 계속 남으므로, 선택을 해제할 때는
   * 생략이 아니라 **서버 기본값을 명시적으로 다시 보내야** 되돌아간다(검토 MC1-01).
   */
  private overridden = false
  /** 마지막 `thread/start`/`thread/resume` 응답이 알려 준 그 대화의 model·effort. */
  private threadModel: string | null = null
  private threadEffort: string | null = null
  /** 재개한 대화가 기본값과 다른지 한 번만 본다. */
  private resumeChecked = false
  /** 서버가 새 대화에 실제로 쓰는 기본값(계정·CLI 설정). `model/list` 나 설정을 추측하지 않는다. */
  private defaults?: { model: string; effort: string | null }
  /** 마지막 `model/list` 결과 — 고른 모델의 기본 생각 깊이를 찾는 데 쓴다. */
  private catalog?: ChatModelInfo[]
  private waiter?: { resolve: () => void; reject: (error: Error) => void }
  private approvals = new Map<string, number | string>()
  private messages = new Map<string, string>()
  /**
   * 최신 CLI 는 평문 `app-server`; 실패하면 옛 `--listen stdio://` 로 한 번 재시도한다.
   * 앞의 `-c` 는 전역 knuaf-dev 스킬 사본을 끄는 config 오버라이드 — ~/.codex/skills 등에
   * 낡은 사본이 있으면 프로젝트 사본과 함께 enabled 로 보여 모델이 옛 지침을 따른다.
   * Claude 는 settingSources 로 막는 자리이고 Codex 에는 세션 범위 옵션이 없어 프로세스
   * 오버라이드로 대신한다(사용자 config.toml 은 건드리지 않는다). live 스모크가 검증.
   */
  private serverArgs: string[]
  /** stop() 이후에는 진행 중인 connect() 의 재시도가 새 프로세스를 다시 띄우지 않는다. */
  private stopped = false
  constructor(private options: AgentOptions) {
    this.serverArgs = serverArgsFor(options.env)
  }
  private async connect(): Promise<JsonRpcProcess> {
    if (this.stopped) throw new Error('Codex 연결이 중단됐어요.')
    /**
     * **초기화가 끝난 연결만** 돌려준다. `open()` 은 initialize 응답을 기다리기 전에
     * `this.rpc` 를 넣으므로, 그 값을 먼저 돌려주면 그 사이에 나간 요청(모델 목록 등)이
     * 서버에서 `Not initialized` 로 거절된다(검토 MC1-02). 진행 중인 한 번을 함께 기다린다 —
     * 동시에 부른 쪽이 각자 프로세스를 띄우는 것도 같은 자리에서 막힌다.
     */
    const inflight = this.connecting
    if (inflight) return inflight
    if (this.rpc && !this.rpc.closed) return this.rpc
    return (this.connecting = this.open().finally(() => { this.connecting = undefined }))
  }
  private connecting?: Promise<JsonRpcProcess>
  private async open(): Promise<JsonRpcProcess> {
    if (this.stopped) throw new Error('Codex 연결이 중단됐어요.')
    if (this.rpc && !this.rpc.closed) return this.rpc
    // 인자는 Codex CLI 쪽 사정이라 고정할 수 없다. 최신 CLI 의 `app-server` 에는
    // --listen 이 없어서(0.155 에서 확인) 그 인자로 띄우면 아무 말 없이 즉시 끝난다.
    // 구버전에는 필요했으므로 평문을 먼저 쓰고 실패하면 옛 인자로 한 번 더 시도한다.
    const rpc = this.rpc = new JsonRpcProcess(this.options.binary, this.serverArgs, this.options.root, this.options.env)
    rpc.onNotification = (method, p) => {
      if (p?.threadId && p.threadId !== this.thread) return
      if (method === 'item/agentMessage/delta') {
        const text = (this.messages.get(p.itemId) ?? '') + p.delta
        this.messages.set(p.itemId, text); this.events?.message(p.itemId, text)
      } else if (method === 'item/completed' && p.item?.type === 'agentMessage') {
        this.events?.message(p.item.id, p.item.text)
      } else if (method === 'turn/started') this.turn = p.turn.id
      else if (method === 'turn/completed') {
        const w = this.waiter; this.waiter = undefined; this.turn = undefined
        if (p.turn.status === 'completed') w?.resolve()
        else w?.reject(new Error(p.turn.error?.message ?? '작업이 중단됐어요. 저장된 대화에서 이어갈 수 있어요.'))
      }
    }
    rpc.onRequest = (id, method, p) => {
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        this.approvals.set(String(id), id)
        // 이유(reason)와 명령(command)을 **둘 다** 남긴다 — 예전 `p.command ?? p.reason` 은 명령이
        // 있으면 이유를 버려, 화면이 "무엇을 왜 허락하는지"를 말할 수 없었다(검토 QA N-I05).
        // 권한 정책·승인 동작은 그대로고, 학생에게 보여 줄 문자열만 넓힌다.
        const detail = [p.command, p.reason].filter((v: unknown): v is string => typeof v === 'string' && v.trim() !== '').join('\n\n')
        this.events?.permission({ id: String(id), title: method.includes('commandExecution') ? '명령 실행 확인' : '파일 변경 확인', detail: detail || JSON.stringify(p) })
      } else if (method === 'item/tool/requestUserInput') {
        // The unmodified interview contract requires chat text, not tool popups.
        rpc.send({ id, result: { answers: {} } })
      } else rpc.send({ id, error: { code: -32601, message: '이 요청은 GUI에서 지원하지 않습니다. 질문은 채팅 텍스트로 제시하세요.' } })
    }
    rpc.onClose = () => { this.waiter?.reject(new Error('Codex 연결이 종료됐어요. 답변은 자동 재전송하지 않아요.')); this.waiter = undefined }
    let init: { userAgent?: string } | undefined
    try {
      init = await rpc.request('initialize', { clientInfo: { name: 'knuaf_dev_gui', version: '0.3.0' }, capabilities: { experimentalApi: true } })
    } catch (e) {
      this.rpc = undefined
      await rpc.stop().catch(() => {})
      if (this.stopped) throw e
      if (!this.serverArgs.includes('--listen')) {
        // 평문이 안 되면 옛 인자로 한 번 더. 다음 connect() 부터는 그 인자를 쓴다.
        this.serverArgs = [...this.serverArgs, '--listen', 'stdio://']
        return this.open()
      }
      // 원인을 지어내지 않는다. 전에는 버전이 낮다고 단정했는데, 실제로는 CLI 가 새로워
      // 인자가 바뀐 경우였고 사용자를 엉뚱한 업데이트로 보냈다.
      const detail = [(e as Error)?.message, rpc.lastStderr].filter(Boolean).join(' / ')
      throw new Error('Codex와 연결하지 못했어요.' + (detail ? ` (${detail})` : ''))
    }
    // The server answers with a userAgent like "knuaf_dev_gui/0.133.0 (Mac OS …)": first token after '/' is the Codex version.
    const ua = typeof init?.userAgent === 'string' ? init.userAgent : ''
    this.serverVersion = /^[^/\s]+\/([^\s]+)/.exec(ua)?.[1] ?? /(\d+\.\d+\.\d+)/.exec(ua)?.[1] ?? null
    rpc.send({ method: 'initialized', params: {} })
    return rpc
  }
  async status() {
    const rpc = await this.connect()
    const r = await rpc.request('account/read', { refreshToken: false })
    const connected = r.account?.type === 'chatgpt'
    // 정상(연결됨)일 때는 조용해야 한다 — detail은 미연결 설명에만 쓴다.
    return { installed: true, connected, version: this.serverVersion, probe: 'ok' as const, detail: connected ? '' : 'ChatGPT 로그인이 필요해요. API 계정으로 자동 전환하지 않아요.' }
  }
  /**
   * 이 계정이 쓸 수 있는 모델(`model/list`). 요금제마다 목록이 다르므로 앱에 박아 두지 않고
   * 계정에 묻는다 — 목록에 없는 모델은 추천에서도 칩에서도 빠진다.
   *
   * `hidden` 은 기본 고르기 목록에서 숨긴 모델이라 뺀다. `model`(턴에 넣는 값)이 비어 있는
   * 응답은 건너뛴다. 쪽이 남아 있으면 이어 받는다(서버가 한 번에 다 안 줄 수 있다).
   * 실계정 목록은 미확인이다 — 이번 판 시험은 가짜 서버로만 돈다.
   */
  async models(): Promise<ChatModelInfo[]> {
    const rpc = await this.connect()
    const out: ChatModelInfo[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    // 서버가 끝나지 않는 쪽을 계속 주는 경우에도 화면이 멈추지 않게 상한을 둔다.
    for (let page = 0; page < 20; page++) {
      const r = await rpc.request('model/list', cursor ? { limit: 100, cursor } : { limit: 100 })
      const data: unknown[] = Array.isArray(r?.data) ? r.data : []
      for (const raw of data) {
        if (!raw || typeof raw !== 'object') continue
        const m = raw as Record<string, unknown>
        if (m.hidden === true) continue
        const model = typeof m.model === 'string' && m.model ? m.model : typeof m.id === 'string' ? m.id : ''
        if (!model || seen.has(model)) continue
        seen.add(model)
        const efforts = Array.isArray(m.supportedReasoningEfforts)
          ? m.supportedReasoningEfforts
            .map((e) => (e && typeof e === 'object' && 'reasoningEffort' in e ? e.reasoningEffort : undefined))
            .filter((e): e is string => typeof e === 'string' && e !== '')
          : []
        out.push({
          model,
          name: typeof m.displayName === 'string' && m.displayName ? m.displayName : model,
          description: typeof m.description === 'string' ? m.description : '',
          efforts,
          defaultEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : null,
          isDefault: m.isDefault === true
        })
      }
      cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null
      if (!cursor) break
    }
    this.catalog = out
    return out
  }
  async login() {
    const r = await (await this.connect()).request('account/login/start', { type: 'chatgpt' })
    this.loginInfo = { id: typeof r.loginId === 'string' ? r.loginId : '', url: typeof r.authUrl === 'string' ? r.authUrl : '' }
    // 브라우저를 못 열었다고 로그인 자체를 실패로 만들지 않는다. 서버 쪽 로그인은 이미
    // 시작됐고, 학생에게는 "브라우저 다시 열기"가 있다. 여기서 던지면 화면이 '확인 실패'가
    // 되어 방금 시작한 로그인을 취소한 것처럼 보인다(실제로 그 문구가 떴다 —
    // openExternal('about:blank') 이 거절하는 환경에서 e2e 가 잡았다).
    if (this.loginInfo.url) { try { await this.options.openExternal(this.loginInfo.url) } catch { /* 다시 열기로 재시도할 수 있다 */ } }
  }
  /** 브라우저를 닫아 버린 학생을 위해 같은 주소를 다시 연다. */
  async reopenLogin() {
    if (!this.loginInfo?.url) throw new Error('다시 열 로그인 주소가 없어요. 로그인을 다시 시작해 주세요.')
    await this.options.openExternal(this.loginInfo.url)
  }
  /**
   * 취소는 app-server 의 `account/login/cancel` 이다(0.162.1 실측: `{ loginId }` 를 요구하고,
   * 빠지면 `Invalid request: missing field \`loginId\`` 를 돌려준다). 이어서 프로세스도 닫는다 —
   * 옛 CLI 에 그 메서드가 없을 수 있고, 남은 프로세스가 로그인을 계속 물고 있으면
   * 취소가 화면에서만 일어난 것처럼 보인다. ChatService 는 취소 뒤 이 연결을 버리므로
   * 다음 확인이 새 프로세스로 상태를 다시 묻는다.
   */
  async cancelLogin() {
    const rpc = this.rpc
    const loginId = this.loginInfo?.id
    this.loginInfo = undefined
    if (rpc && !rpc.closed && loginId) {
      try { await rpc.request('account/login/cancel', { loginId }) } catch { /* 옛 CLI: 메서드가 없으면 프로세스를 닫아 취소한다 */ }
    }
    await this.stop()
  }
  private loginInfo?: { id: string; url: string }
  async run(text: string, sessionId: string | undefined, events: AgentEvents, replayHistory = false) {
    const rpc = await this.connect()
    if (!(await this.status()).connected) throw new Error('Codex에서 ChatGPT 계정 로그인을 먼저 완료해 주세요.')
    this.events = events
    const skillPath = join(this.options.skill, 'SKILL.md')
    // Codex 는 스킬 경로를 realpath 로 보고한다. 앱이 쥔 경로는 학생이 고른 그대로다.
    // 심링크를 하나라도 지나면 문자열 비교가 어긋나 "스킬을 찾지 못했어요" 로 막힌다.
    // macOS 에서 iCloud 데스크톱을 켜면 ~/Desktop 이 심링크가 되므로 드문 경우가 아니다
    // (임시 폴더 /var → /private/var 가 live 스모크에서 이걸 먼저 드러냈다).
    const want = realOrSelf(skillPath)
    const skills = await rpc.request('skills/list', { cwds: [this.options.root], forceReload: true })
    if (!skills.data?.some((entry: any) => entry.skills?.some((s: any) => realOrSelf(s.path) === want && s.enabled))) throw new Error('Codex가 프로젝트의 knuaf-dev 스킬을 찾지 못했어요.')
    events.skill()
    const args = { cwd: this.options.root, approvalPolicy: 'on-request', sandbox: 'workspace-write', developerInstructions: '이 세션은 knuaf-dev 개인용 GUI입니다. 제공된 knuaf-dev 스킬과 참조 지침을 그대로 따르세요. 같은 이름의 사용자·전역 스킬 사본이 보여도 무시하고 이 프로젝트의 스킬만 따르세요. 질문은 채팅 텍스트로 제시하세요. 인터뷰 원문과 해석은 스킬의 로그 계약대로 기록하세요. GUI의 첨부는 사용자 답변의 일부이며 현재 작성물 채택은 스킬의 확인 절차를 따르세요. 셸 명령은 앱이 그대로 읽고 판단할 수 있어야 자동으로 통과합니다. 변수 대입($PY=… 같은)·$PWD 같은 변수 참조·`…`·$(…)·서브셸·리다이렉트를 쓰지 말고, 경로는 따옴표로 감싼 절대경로를 그대로 적으세요. 그러지 않으면 학생에게 읽을 수 없는 승인 창이 뜹니다. 셸에 프로그램을 밀어 넣지 마세요(heredoc·python -c 등). 엑셀·문서 읽기는 스킬의 스크립트에 이미 있으니 그것을 쓰세요.' }
    const r = sessionId ? await rpc.request('thread/resume', { ...args, threadId: sessionId }) : await rpc.request('thread/start', args)
    this.thread = r.thread.id; events.session(r.thread.id)
    this.threadModel = typeof r.model === 'string' && r.model ? r.model : null
    this.threadEffort = typeof r.reasoningEffort === 'string' && r.reasoningEffort ? r.reasoningEffort : null
    if (!sessionId) { this.overridden = false; this.resumeChecked = false }
    // Replayed turns use a different id space (item-N) than the live stream (msg_*), so
    // id-dedup cannot catch them — replay only when the app snapshot has no assistant
    // history at all (e.g. snapshot file lost while the server thread survived).
    if (replayHistory) for (const turn of r.thread.turns ?? []) for (const item of turn.items ?? []) if (item.type === 'agentMessage') events.message(item.id, item.text)
    this.messages.clear()
    // 첫 턴에는 작업 루트를 명시한다 — 모델이 하위 폴더(knuaf-work 등)를 추측하지 않게.
    const prompt = sessionId ? text : `${text}\n\n작업 폴더: ${this.options.root}\n이 폴더 자체가 논문 작업 폴더예요. 하위 폴더를 새로 만들지 말고 여기서 바로 작업해 주세요.`
    /**
     * 학생이 고른 모델·생각 깊이. `turn/start` 의 model/effort 는 **이 턴과 그 뒤 턴에**
     * 적용되므로(turnStartParams: "this turn and subsequent turns") 같은 대화의 맥락이
     * 끊기지 않는다. 다만 그래서 **생략은 "기본값으로 돌아가기"가 아니다** — 예전에 보낸
     * Sol/high 가 그대로 남는다. 고른 적이 없으면 지금처럼 키를 넣지 않고, 해제했다면
     * 서버가 새 대화에 쓰는 기본값을 명시적으로 다시 보낸다(검토 MC1-01).
     */
    const turnModel = await this.turnModelParams(!!sessionId)
    await new Promise<void>((resolve, reject) => {
      this.waiter = { resolve, reject }
      rpc.request('turn/start', {
        threadId: this.thread,
        input: [{ type: 'text', text: prompt, text_elements: [] }, { type: 'skill', name: 'knuaf-dev', path: skillPath }],
        ...turnModel.params
      }).then(r => {
        this.turn = r.turn.id
        // 되돌리기를 실제로 보낸 턴이 시작됐을 때만 "더 되돌릴 것이 없다"로 바꾼다.
        // 턴이 실패했는데 false 로 두면 다음 턴이 생략되어 예전 덮어쓰기가 남는다.
        if (turnModel.clears) this.overridden = false
      }).catch(e => { this.waiter = undefined; reject(e) })
    })
  }
  /**
   * 이 턴에 실을 model·effort. 네 경우를 구분한다.
   * 1. 고른 모델이 있다 → 그 모델 + (고른 깊이 또는 그 모델의 기본 깊이).
   * 2. 고른 적이 없고 이 대화에 덮어쓴 적도 없다 → 아무 키도 넣지 않는다(지금까지와 같은 요청).
   * 3. 이 앱이 덮어쓴 뒤 해제했다 → 서버 기본값을 **명시적으로** 보내 되돌린다.
   * 4. 앱을 다시 켜서 재개했고 선택이 없다 → 그 대화가 기본값과 다른지 한 번 보고, 다르면 3과 같다.
   *
   * 기본값은 `model/list` 의 isDefault 나 CLI 설정을 **추측하지 않는다** — 서버에 새 대화를
   * 하나 물어(ephemeral) 실제로 쓸 model·effort 를 받아 그대로 보낸다.
   */
  private async turnModelParams(resumed: boolean): Promise<{ params: { model?: string; effort?: string }; clears: boolean }> {
    const choice = this.options.modelChoice?.() ?? null
    if (choice?.model) {
      this.overridden = true
      const effort = choice.effort ?? await this.defaultEffortOf(choice.model)
      return { params: { model: choice.model, ...(effort ? { effort } : {}) }, clears: false }
    }
    if (!this.overridden && resumed && !this.resumeChecked) {
      this.resumeChecked = true
      try {
        const base = await this.serverDefaults()
        const baseEffort = base.effort ?? await this.defaultEffortOf(base.model)
        this.overridden = this.threadModel !== base.model || this.threadEffort !== baseEffort
      } catch { /* 기본값을 못 물으면 지금까지처럼 생략한다 — 보내던 요청을 막지 않는다 */ }
    }
    if (!this.overridden) return { params: {}, clears: false }
    const base = await this.serverDefaults()
    const effort = base.effort ?? await this.defaultEffortOf(base.model)
    return { params: { model: base.model, ...(effort ? { effort } : {}) }, clears: true }
  }
  /**
   * 서버가 새 대화에 쓰는 기본 model·effort. `ephemeral` 대화는 디스크에 남지 않는다.
   * 한 연결에서 한 번만 묻는다 — 학생 설정·요금제가 바뀌면 앱을 다시 켜며 연결도 새로 생긴다.
   */
  private async serverDefaults(): Promise<{ model: string; effort: string | null }> {
    if (this.defaults) return this.defaults
    const rpc = await this.connect()
    const r = await rpc.request('thread/start', { ephemeral: true, cwd: this.options.root })
    const model = typeof r?.model === 'string' && r.model ? r.model : ''
    if (!model) throw new Error('Codex가 기본 모델을 알려 주지 않았어요.')
    this.defaults = { model, effort: typeof r?.reasoningEffort === 'string' && r.reasoningEffort ? r.reasoningEffort : null }
    return this.defaults
  }
  /** 그 모델의 기본 생각 깊이(`model/list`). 목록에 없으면 null — 깊이는 생략한다. */
  private async defaultEffortOf(model: string): Promise<string | null> {
    if (!this.catalog) {
      try { await this.models() } catch { /* 목록 없이도 모델 선택은 보낸다 */ }
    }
    return this.catalog?.find(m => m.model === model)?.defaultEffort ?? null
  }
  respond(id: string, allow: boolean) {
    const request = this.approvals.get(id)
    if (request === undefined) throw new Error('이미 종료된 권한 요청이에요.')
    this.rpc?.send({ id: request, result: { decision: allow ? 'accept' : 'decline' } }); this.approvals.delete(id)
  }
  async stop() {
    this.stopped = true
    if (this.turn && this.thread && this.rpc && !this.rpc.closed) {
      try { await this.rpc.request('turn/interrupt', { threadId: this.thread, turnId: this.turn }) } catch { /* process termination below */ }
    }
    await this.rpc?.stop(); this.rpc = undefined; this.approvals.clear()
  }
}
