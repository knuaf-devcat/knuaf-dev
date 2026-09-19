import { join } from 'node:path'
import { JsonRpcProcess } from './transport'
import type { AgentConnection, AgentEvents, AgentOptions } from './contracts'

export class CodexConnection implements AgentConnection {
  private rpc?: JsonRpcProcess
  private events?: AgentEvents
  private serverVersion: string | null = null
  private thread?: string
  private turn?: string
  private waiter?: { resolve: () => void; reject: (error: Error) => void }
  private approvals = new Map<string, number | string>()
  private messages = new Map<string, string>()
  constructor(private options: AgentOptions) {}
  private async connect() {
    if (this.rpc && !this.rpc.closed) return this.rpc
    const rpc = this.rpc = new JsonRpcProcess(this.options.binary, ['app-server', '--listen', 'stdio://'], this.options.root, this.options.env)
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
    } catch {
      this.rpc = undefined
      await rpc.stop().catch(() => {})
      throw new Error('Codex App Server를 시작하지 못했어요. Codex 버전(0.133 이상)을 확인해 주세요.')
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
    return { installed: true, connected, version: this.serverVersion, detail: connected ? 'ChatGPT 계정 연결됨' : 'ChatGPT 로그인이 필요해요. API 계정으로 자동 전환하지 않아요.' }
  }
  async login() {
    const r = await (await this.connect()).request('account/login/start', { type: 'chatgpt' })
    if (r.authUrl) await this.options.openExternal(r.authUrl)
  }
  async run(text: string, sessionId: string | undefined, events: AgentEvents) {
    const rpc = await this.connect()
    if (!(await this.status()).connected) throw new Error('Codex에서 ChatGPT 계정 로그인을 먼저 완료해 주세요.')
    this.events = events
    const skillPath = join(this.options.skill, 'SKILL.md')
    const skills = await rpc.request('skills/list', { cwds: [this.options.root], forceReload: true })
    if (!skills.data?.some((entry: any) => entry.skills?.some((s: any) => s.path === skillPath && s.enabled))) throw new Error('Codex가 프로젝트의 knuaf-doc 스킬을 찾지 못했어요.')
    events.skill()
    const args = { cwd: this.options.root, approvalPolicy: 'on-request', sandbox: 'workspace-write', developerInstructions: '이 세션은 knuaf-doc 개인용 GUI입니다. 제공된 knuaf-doc 스킬과 참조 지침을 그대로 따르세요. 질문은 채팅 텍스트로 제시하세요. 인터뷰 원문과 해석은 스킬의 로그 계약대로 기록하세요. GUI의 첨부는 사용자 답변의 일부이며 현재 작성물 채택은 스킬의 확인 절차를 따르세요.' }
    const r = sessionId ? await rpc.request('thread/resume', { ...args, threadId: sessionId }) : await rpc.request('thread/start', args)
    this.thread = r.thread.id; events.session(r.thread.id)
    for (const turn of r.thread.turns ?? []) for (const item of turn.items ?? []) if (item.type === 'agentMessage') events.message(item.id, item.text)
    this.messages.clear()
    await new Promise<void>((resolve, reject) => {
      this.waiter = { resolve, reject }
      rpc.request('turn/start', { threadId: this.thread, input: [{ type: 'text', text, text_elements: [] }, { type: 'skill', name: 'knuaf-doc', path: skillPath }] }).then(r => { this.turn = r.turn.id }).catch(e => { this.waiter = undefined; reject(e) })
    })
  }
  respond(id: string, allow: boolean) {
    const request = this.approvals.get(id)
    if (request === undefined) throw new Error('이미 종료된 권한 요청이에요.')
    this.rpc?.send({ id: request, result: { decision: allow ? 'accept' : 'decline' } }); this.approvals.delete(id)
  }
  async stop() {
    if (this.turn && this.thread && this.rpc && !this.rpc.closed) {
      try { await this.rpc.request('turn/interrupt', { threadId: this.thread, turnId: this.turn }) } catch { /* process termination below */ }
    }
    await this.rpc?.stop(); this.rpc = undefined; this.approvals.clear()
  }
}
