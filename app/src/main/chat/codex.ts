import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { JsonRpcProcess } from './transport'
import { codexSkillConfigOverride } from '../agent'
import type { AgentConnection, AgentEvents, AgentOptions } from './contracts'

/** 존재하면 realpath, 아니면 입력 그대로. 경로 비교는 반드시 이것을 거친다. */
export function realOrSelf(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/**
 * `codex app-server` argv. `-c 'skills.config=…'`(전역 knuaf-doc 사본 끄기)는 subcommand
 * 앞에 온다 — codex 의 config 오버라이드는 루트 인자다. 존재하는 사본이 없으면 순수
 * `['app-server']`. 단위 테스트가 이 모양을 고정한다(e2e/agent.spec.ts).
 */
export function serverArgsFor(env: NodeJS.ProcessEnv): string[] {
  const cfg = codexSkillConfigOverride(env.HOME)
  return cfg ? ['-c', cfg, 'app-server'] : ['app-server']
}

export class CodexConnection implements AgentConnection {
  private rpc?: JsonRpcProcess
  private events?: AgentEvents
  private serverVersion: string | null = null
  private thread?: string
  private turn?: string
  private waiter?: { resolve: () => void; reject: (error: Error) => void }
  private approvals = new Map<string, number | string>()
  private messages = new Map<string, string>()
  /**
   * 최신 CLI 는 평문 `app-server`; 실패하면 옛 `--listen stdio://` 로 한 번 재시도한다.
   * 앞의 `-c` 는 전역 knuaf-doc 스킬 사본을 끄는 config 오버라이드 — ~/.codex/skills 등에
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
        this.events?.permission({ id: String(id), title: method.includes('commandExecution') ? '명령 실행 확인' : '파일 변경 확인', detail: p.command ?? p.reason ?? JSON.stringify(p) })
      } else if (method === 'item/tool/requestUserInput') {
        // The unmodified interview contract requires chat text, not tool popups.
        rpc.send({ id, result: { answers: {} } })
      } else rpc.send({ id, error: { code: -32601, message: '이 요청은 GUI에서 지원하지 않습니다. 질문은 채팅 텍스트로 제시하세요.' } })
    }
    rpc.onClose = () => { this.waiter?.reject(new Error('Codex 연결이 종료됐어요. 답변은 자동 재전송하지 않아요.')); this.waiter = undefined }
    let init: { userAgent?: string } | undefined
    try {
      init = await rpc.request('initialize', { clientInfo: { name: 'knuaf_doc_gui', version: '0.2.0' }, capabilities: { experimentalApi: true } })
    } catch (e) {
      this.rpc = undefined
      await rpc.stop().catch(() => {})
      if (this.stopped) throw e
      if (!this.serverArgs.includes('--listen')) {
        // 평문이 안 되면 옛 인자로 한 번 더. 다음 connect() 부터는 그 인자를 쓴다.
        this.serverArgs = [...this.serverArgs, '--listen', 'stdio://']
        return this.connect()
      }
      // 원인을 지어내지 않는다. 전에는 버전이 낮다고 단정했는데, 실제로는 CLI 가 새로워
      // 인자가 바뀐 경우였고 사용자를 엉뚱한 업데이트로 보냈다.
      const detail = [(e as Error)?.message, rpc.lastStderr].filter(Boolean).join(' / ')
      throw new Error('Codex와 연결하지 못했어요.' + (detail ? ` (${detail})` : ''))
    }
    // The server answers with a userAgent like "knuaf_doc_gui/0.133.0 (Mac OS …)": first token after '/' is the Codex version.
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
    return { installed: true, connected, version: this.serverVersion, detail: connected ? '' : 'ChatGPT 로그인이 필요해요. API 계정으로 자동 전환하지 않아요.' }
  }
  async login() {
    const r = await (await this.connect()).request('account/login/start', { type: 'chatgpt' })
    if (r.authUrl) await this.options.openExternal(r.authUrl)
  }
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
    if (!skills.data?.some((entry: any) => entry.skills?.some((s: any) => realOrSelf(s.path) === want && s.enabled))) throw new Error('Codex가 프로젝트의 knuaf-doc 스킬을 찾지 못했어요.')
    events.skill()
    const args = { cwd: this.options.root, approvalPolicy: 'on-request', sandbox: 'workspace-write', developerInstructions: '이 세션은 knuaf-doc 개인용 GUI입니다. 제공된 knuaf-doc 스킬과 참조 지침을 그대로 따르세요. 같은 이름의 사용자·전역 스킬 사본이 보여도 무시하고 이 프로젝트의 스킬만 따르세요. 질문은 채팅 텍스트로 제시하세요. 인터뷰 원문과 해석은 스킬의 로그 계약대로 기록하세요. GUI의 첨부는 사용자 답변의 일부이며 현재 작성물 채택은 스킬의 확인 절차를 따르세요. 셸 명령은 앱이 그대로 읽고 판단할 수 있어야 자동으로 통과합니다. 변수 대입($PY=… 같은)·$PWD 같은 변수 참조·`…`·$(…)·서브셸·리다이렉트를 쓰지 말고, 경로는 따옴표로 감싼 절대경로를 그대로 적으세요. 그러지 않으면 학생에게 읽을 수 없는 승인 창이 뜹니다. 셸에 프로그램을 밀어 넣지 마세요(heredoc·python -c 등). 엑셀·문서 읽기는 스킬의 스크립트에 이미 있으니 그것을 쓰세요.' }
    const r = sessionId ? await rpc.request('thread/resume', { ...args, threadId: sessionId }) : await rpc.request('thread/start', args)
    this.thread = r.thread.id; events.session(r.thread.id)
    // Replayed turns use a different id space (item-N) than the live stream (msg_*), so
    // id-dedup cannot catch them — replay only when the app snapshot has no assistant
    // history at all (e.g. snapshot file lost while the server thread survived).
    if (replayHistory) for (const turn of r.thread.turns ?? []) for (const item of turn.items ?? []) if (item.type === 'agentMessage') events.message(item.id, item.text)
    this.messages.clear()
    // 첫 턴에는 작업 루트를 명시한다 — 모델이 하위 폴더(knuaf-work 등)를 추측하지 않게.
    const prompt = sessionId ? text : `${text}\n\n작업 폴더: ${this.options.root}\n이 폴더 자체가 논문 작업 폴더예요. 하위 폴더를 새로 만들지 말고 여기서 바로 작업해 주세요.`
    await new Promise<void>((resolve, reject) => {
      this.waiter = { resolve, reject }
      rpc.request('turn/start', { threadId: this.thread, input: [{ type: 'text', text: prompt, text_elements: [] }, { type: 'skill', name: 'knuaf-doc', path: skillPath }] }).then(r => { this.turn = r.turn.id }).catch(e => { this.waiter = undefined; reject(e) })
    })
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
