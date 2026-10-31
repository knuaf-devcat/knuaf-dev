// CL-WIN2-01: 실제 SDK + 가짜 CLI + 실제 main/renderer store. 앱 창·실제 계정은 열지 않는다.
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mock } from 'node:test'
import { runInNewContext } from 'node:vm'
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClaudeConnection, claudeAuthenticationFailed } from '../src/main/chat/claude'
import { ChatService } from '../src/main/chat/service'
import { skillSource } from '../src/main/agent'
import { useChat } from '../src/renderer/src/store/chat'
import { displayState, useConnect } from '../src/renderer/src/store/connect'
import { CLAUDE_AUTH_COPY } from '../src/shared/copy'
import type { ChatSnapshot } from '../src/shared/chat'

const expired = 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.'

test('W1-4: SDK 인증 오류만 구분하며 한도·네트워크·답변에 인용된 401은 제외한다', () => {
  for (const message of [
    { type: 'assistant', error: 'authentication_failed' },
    { type: 'result', is_error: true, errors: [expired] }, new Error(expired)
  ]) expect(claudeAuthenticationFailed(message)).toBe(true)
  for (const message of [
    { type: 'assistant', error: 'rate_limit' },
    { type: 'result', is_error: true, errors: ['API Error: 429 rate limit exceeded'] },
    { type: 'result', is_error: true, errors: ['Network error: ECONNRESET'] },
    { type: 'assistant', message: { content: [{ type: 'text', text: expired }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: expired }] } },
    { type: 'result', is_error: false, errors: [expired] },
    new Error('Failed to authenticate to git'), new Error('401 from external research website'), null
  ]) expect(claudeAuthenticationFailed(message)).toBe(false)
})

function rig(extra: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kd-claude-auth-')))
  const log = join(root, 'query.jsonl')
  const complete = join(root, 'complete-login')
  const state = join(root, 'authenticated')
  const fixture = resolve(__dirname, 'fixtures/fake-claude-query.mjs')
  const binary = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  writeFileSync(binary, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 })
  const env = { ...process.env, W1_QUERY_LOG: log, W1_AUTH_STATE: state, W1_LOGIN_COMPLETE: complete, ...extra }
  const snapshots: ChatSnapshot[] = []
  const opened: string[] = []
  const svc = new ChatService({ skillSource: () => skillSource(resolve(__dirname, '..'), false, ''),
    userData: join(root, 'userdata'),
    emit: s => { snapshots.push(s); useChat.getState().onSnapshot(s) },
    openExternal: async url => { opened.push(url) },
    connectionFactory: (provider, options) => provider === 'claude'
      ? new ClaudeConnection({ ...options, binary, env })
      : { status: async () => ({ installed: true, connected: true, version: null, detail: '' }), login: async () => {}, run: async () => {}, respond: () => {}, stop: async () => {} }
  })
  return { root, log, complete, state, env, binary, svc, opened, snapshots }
}

async function settled(svc: ChatService, root: string) {
  await expect.poll(() => svc.snapshot(root, 'claude').state, { timeout: 15_000 }).not.toBe('running')
  return svc.snapshot(root, 'claude')
}

/** 실제 소스를 React용으로 변환한다. Playwright의 기본 JSX는 별도의 시험용 형식이다. */
function rowHtml(): string {
  const state = useConnect.getState()
  const file = resolve(__dirname, '../src/renderer/src/components/ConnectRow.tsx')
  const js = transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022
  } }).outputText
  const load = createRequire(file)
  const exports: any = {}
  runInNewContext(js, { exports, require: name => name === '../store/connect'
    ? { displayState, useConnect: selector => selector(state) } : load(name) })
  return renderToStaticMarkup(createElement(exports.ConnectRow, { provider: 'claude' }))
}

test('W1-4: 401 → 로그인 단추 렌더 → 앱 안 재로그인 → 이어 보내기', async () => {
  const r = rig()
  mkdirSync(join(r.root, '.knuaf-gui'), { recursive: true })
  writeFileSync(join(r.root, '.knuaf-gui', 'chat-claude.json'), JSON.stringify({
    root: r.root, provider: 'claude', sessionId: 'prior-session', state: 'idle',
    messages: [{ id: 'prior', role: 'assistant', text: '기존 대화', at: new Date().toISOString() }]
  }))
  const previousWindow = (globalThis as any).window
  const chatBefore = useChat.getState()
  const connectBefore = useConnect.getState()
  ;(globalThis as any).window = { knuaf: { connect: {
    login: async () => { await r.svc.globalLogin('claude'); return { result: true } },
    status: async () => ({ result: await r.svc.globalStatus('claude') })
  }, chat: { status: async () => ({ result: await r.svc.status(r.root, 'claude') }) } } }
  useChat.setState({ root: r.root, provider: 'claude', connState: 'connected', status: { installed: true, connected: true, version: null, detail: '' } })
  useConnect.setState({ claude: { state: 'connected', detail: '', version: null }, loggingIn: { codex: false, claude: false } })
  try {
    expect((await r.svc.globalStatus('claude')).connected).toBe(true)
    await r.svc.send(r.root, 'claude', '만료된 인증으로 첫 요청', 'expired')
    const failed = await settled(r.svc, r.root)
    expect(failed).toMatchObject({ state: 'error', authRequired: true, error: CLAUDE_AUTH_COPY.required })
    expect(failed.messages.filter(m => m.role === 'assistant').map(m => m.text)).toEqual(['기존 대화'])
    expect(useChat.getState().connState).toBe('need-login')
    expect(useConnect.getState().claude.state).toBe('need-login')
    expect(rowHtml()).toContain('Claude로 로그인')
    expect(rowHtml()).not.toContain('연결됐어요')
    expect((await r.svc.globalStatus('claude')).connected).toBe(false)
    expect((await r.svc.status(r.root, 'claude')).connected).toBe(false)
    expect((await r.svc.globalStatus('codex')).connected).toBe(true)
    await expect(r.svc.send(r.root, 'claude', '로그인 전 중복 전송', 'blocked')).rejects.toThrow(CLAUDE_AUTH_COPY.required)
    expect(r.svc.snapshot(r.root, 'claude').messages.some(m => m.id === 'blocked')).toBe(false)

    // ConnectRow 로그인 단추가 부르는 실제 store→IPC→main→CLI 경로.
    await useConnect.getState().login('claude')
    await expect.poll(() => r.opened).toEqual(['https://example.invalid/fake-claude-login'])
    await useConnect.getState().refresh('claude')
    expect(useConnect.getState().claude.state).toBe('need-login')
    expect(useConnect.getState().loggingIn.claude).toBe(true)
    const commands = readFileSync(r.log, 'utf8').trim().split('\n').map(s => JSON.parse(s))
    expect(commands.some(c => JSON.stringify(c.args) === JSON.stringify(['auth', 'login', '--claudeai']))).toBe(true)
    writeFileSync(r.complete, 'complete fake OAuth')
    await expect.poll(() => useConnect.getState().claude.state, { timeout: 10_000 }).toBe('connected')
    expect(useConnect.getState().loggingIn.claude).toBe(false)
    // App의 기존 연결 구독이 부르는 갱신 경로도 확인한다.
    await useChat.getState().refreshStatus()
    expect(useChat.getState().connState).toBe('connected')
    expect((await r.svc.status(r.root, 'claude')).connected).toBe(true)
    await r.svc.send(r.root, 'claude', '재로그인 후 이어가기', 'recovered')
    const recovered = await settled(r.svc, r.root)
    expect(recovered.state).toBe('idle')
    expect(recovered.authRequired).toBeUndefined()
    expect(recovered.error).toBeUndefined()
    expect(recovered.messages.find(m => m.id === 'recovered')?.delivery).toBe('sent')
    expect(recovered.messages.some(m => m.text === '가짜 CLI 응답')).toBe(true)
    const launches = readFileSync(r.log, 'utf8').trim().split('\n').map(s => JSON.parse(s)).filter(r => r.cwd)
    expect(launches).toHaveLength(2)
    expect(launches.every(r => r.args.includes('--resume=prior-session'))).toBe(true)
    const saved = JSON.parse(readFileSync(join(r.root, '.knuaf-gui', 'chat-claude.json'), 'utf8'))
    expect(saved.messages.some(m => m.id === 'prior' && m.text === '기존 대화')).toBe(true)
  } finally {
    useConnect.getState().stopPolling()
    await r.svc.close()
    useChat.setState(chatBefore, true); useConnect.setState(connectBefore, true)
    ;(globalThis as any).window = previousWindow
  }
})

for (const failure of ['rate_limit', 'network']) test(`W1-4: ${failure}는 연결됨을 로그인 필요로 바꾸지 않는다`, async () => {
  const r = rig({ W1_QUERY_ERROR: failure })
  try {
    await r.svc.send(r.root, 'claude', '오류 구분', 'request')
    const s = await settled(r.svc, r.root)
    expect(s.state).toBe('error')
    expect(s.authRequired).toBeUndefined()
    expect((await r.svc.globalStatus('claude')).connected).toBe(true)
  } finally { await r.svc.close() }
})

test('W1-4: 재로그인 취소·실패는 옛 loggedIn:true로 복구되지 않는다', async () => {
  const r = rig({ W1_LOGIN_FAIL: '1' })
  try {
    await r.svc.send(r.root, 'claude', '실패 전송', 'request')
    await settled(r.svc, r.root)
    await r.svc.globalLogin('claude')
    await expect.poll(() => r.opened.length).toBe(1)
    await r.svc.cancelLogin('claude')
    expect((await r.svc.globalStatus('claude')).connected).toBe(false)
    await r.svc.login(r.root, 'claude')
    await expect.poll(() => r.opened.length).toBe(2)
    writeFileSync(r.complete, 'reject fake login')
    await expect.poll(() => (r.svc as any).connections.get(`${r.root}\0claude`).loginProcess).toBeUndefined()
    expect(existsSync(r.state)).toBe(false)
    expect((await r.svc.globalStatus('claude')).connected).toBe(false)
    // 폴더 로그인 실패 뒤 계정 팝오버에서 성공해도 옛 폴더 연결이 복구를 막으면 안 된다.
    r.env.W1_LOGIN_FAIL = '0'
    r.env.W1_LOGIN_COMPLETE = join(r.root, 'second-login')
    await r.svc.globalLogin('claude')
    writeFileSync(r.env.W1_LOGIN_COMPLETE, 'successful retry')
    await expect.poll(async () => (await r.svc.globalStatus('claude')).connected).toBe(true)
    expect((await r.svc.status(r.root, 'claude')).connected).toBe(true)
    await r.svc.send(r.root, 'claude', '실패한 폴더 연결에서도 복구', 'retry')
    expect((await settled(r.svc, r.root)).state).toBe('idle')
  } finally { await r.svc.close() }
})

test('W1-4: 로그인 시간 초과 뒤 종료 코드 0도 재인증 성공으로 세지 않는다', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
  let timeout: () => void = () => { throw new Error('로그인 제한 타이머 없음') }
  const original = globalThis.setTimeout
  const spawn = mock.method(require('node:child_process'), 'spawn', () => child)
  const timer = mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms !== 180_000) return original(fn, ms, ...args)
    timeout = fn
    return { unref: () => {} }
  })
  try {
    const c = new ClaudeConnection({ binary: '/fake/claude', root: '/', env: {}, skill: '', openExternal: async () => {} })
    await c.login()
    timeout()
    child.emit('close', 0)
    expect(c.loginConfirmed).toBe(false)
  } finally { timer.mock.restore(); spawn.mock.restore() }
})
