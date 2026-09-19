import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { query, type Query, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentConnection, AgentEvents, AgentOptions } from './contracts'

export class ClaudeConnection implements AgentConnection {
  private active?: Query
  private loginProcess?: ChildProcess
  private controller?: AbortController
  private approvals = new Map<string, (allow: boolean) => void>()
  constructor(private options: AgentOptions) {}
  async status() {
    let output = ''
    try { output = (await promisify(execFile)(this.options.binary, ['auth', 'status'], { env: this.options.env, timeout: 12_000 })).stdout }
    catch (e) { output = (e as { stdout?: string }).stdout ?? '{}' }
    let r: any = {}; try { r = JSON.parse(output) } catch { /* unknown authentication => disconnected */ }
    const connected = r.loggedIn === true && r.authMethod === 'claude.ai' && r.apiProvider === 'firstParty'
    return { installed: true, connected, version: null, detail: connected ? 'Claude 개인 계정 연결됨 · 개인용 검증' : 'Claude 구독 계정 로그인이 필요해요. 개인용 검증만 지원하며 API로 자동 전환하지 않아요.' }
  }
  async login() {
    if (this.loginProcess) throw new Error('브라우저에서 진행 중인 로그인을 완료해 주세요.')
    // Official CLI owns credential storage and opens its own browser login.
    const child = this.loginProcess = spawn(this.options.binary, ['auth', 'login', '--claudeai'], { env: this.options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.resume(); child.stderr?.resume()
    child.on('error', () => { this.loginProcess = undefined })
    child.on('close', () => { this.loginProcess = undefined })
    const timer = setTimeout(() => child.kill(), 180_000)
    timer.unref(); child.once('close', () => clearTimeout(timer))
  }
  async run(text: string, sessionId: string | undefined, events: AgentEvents) {
    if (!(await this.status()).connected) throw new Error('Claude 구독 계정 로그인을 완료해 주세요. 이 연결은 아직 실사용 검증 전이에요.')
    this.controller = new AbortController()
    const q = this.active = query({ prompt: sessionId ? text : `/knuaf-doc ${text}`, options: {
      cwd: this.options.root, pathToClaudeCodeExecutable: this.options.binary,
      env: this.options.env, settingSources: ['user', 'project', 'local'],
      resume: sessionId, abortController: this.controller, permissionMode: 'default',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: '이 세션은 개인용 knuaf-doc GUI입니다. knuaf-doc 스킬과 참조 지침을 그대로 따르세요. 질문과 답변은 채팅 텍스트로 유지하고 인터뷰 원문과 해석을 스킬의 로그 계약대로 기록하세요.' },
      canUseTool: async (name, input, options): Promise<PermissionResult> => {
        if (name === 'AskUserQuestion') return { behavior: 'deny', message: 'knuaf-doc 인터뷰 지침에 따라 질문을 채팅 텍스트로 제시하세요.' }
        const id = randomUUID()
        const allowed = await new Promise<boolean>(resolve => {
          const done = (v: boolean) => { options.signal.removeEventListener('abort', aborted); this.approvals.delete(id); resolve(v) }
          const aborted = () => done(false)
          this.approvals.set(id, done)
          options.signal.addEventListener('abort', aborted, { once: true })
          events.permission({ id, title: `${name} 사용 확인`, detail: JSON.stringify(input, null, 2) })
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
