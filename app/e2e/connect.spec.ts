// 폴더 없는 AI 연결(단계 2)의 Node 단위 시험 — 가짜 연결·가짜 CLI만 쓴다.
// 실제 로그인도 실제 AI 호출도 하지 않는다. `codex app-server`·`claude` 는 여기서 띄우지 않는다.
import { expect, test } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { ClaudeConnection } from '../src/main/chat/claude'
import { findExecutable, skillSource } from '../src/main/agent'
import { connInfoOf, displayState, type ConnInfo } from '../src/renderer/src/store/connect'
import type { AgentConnection, AgentOptions } from '../src/main/chat/contracts'
import type { ConnectionStatus } from '../src/shared/chat'

const appRoot = resolve(__dirname, '..')
const source = skillSource(appRoot, false, '/nonexistent')

// ---------------------------------------------------------------- 상태 이름

const status = (over: Partial<ConnectionStatus> = {}): ConnectionStatus =>
  ({ installed: true, connected: false, version: null, detail: '', ...over })

test('확인하지 못한 것과 로그인이 필요한 것은 다른 상태다', () => {
  // 설치 자체가 없으면 도구 없음 — 이건 확인 실패가 아니라 관찰된 사실이다.
  expect(connInfoOf(status({ installed: false })).state).toBe('no-tool')
  // 도구는 있는데 로그인이 안 된 것 — 지금 규칙대로.
  expect(connInfoOf(status({ connected: false })).state).toBe('need-login')
  // 도구는 있는데 대답을 못 들은 것 — 로그인 필요로 꾸미지 않는다(IMPL-R1-04).
  expect(connInfoOf(status({ probe: 'failed' })).state).toBe('failed')
  expect(connInfoOf(status({ connected: true, version: '1.2.3' })).state).toBe('connected')
  // probe 가 없는 응답(옛 호출자·다른 공급자)은 'ok' 로 읽는다 — 동작이 그대로여야 한다.
  expect(connInfoOf(status({ connected: true })).state).toBe('connected')
  expect(connInfoOf(status()).state).toBe('need-login')
  // detail·version 은 그대로 옮겨진다.
  expect(connInfoOf(status({ detail: '설명', version: '0.1' }))).toMatchObject({ detail: '설명', version: '0.1' })
})

test('로그인을 기다리는 동안에는 확인이 로그인 필요를 돌려줘도 그 표시를 지킨다', () => {
  const need: ConnInfo = { state: 'need-login', detail: '', version: null }
  expect(displayState(need, true)).toBe('logging-in')
  expect(displayState(need, false)).toBe('need-login')
  // 끝난 사실은 기다림보다 세다 — 연결됨·확인 실패·도구 없음은 덮지 않는다.
  expect(displayState({ ...need, state: 'connected' }, true)).toBe('connected')
  expect(displayState({ ...need, state: 'failed' }, true)).toBe('failed')
  expect(displayState({ ...need, state: 'no-tool' }, true)).toBe('no-tool')
})

// ---------------------------------------------------------------- 실행 파일 찾기

test('KNUAF_AGENT_PATH_ONLY=1 이면 PATH 만 본다', () => {
  // Finder 로 띄운 앱처럼 PATH 가 비어 있으면 아무것도 찾지 못한다 — 개발 기계에
  // 진짜 codex 가 깔려 있어도 "도구 없음" 화면을 재현할 수 있어야 한다.
  expect(findExecutable('codex', { PATH: '', HOME: tmpdir(), KNUAF_AGENT_PATH_ONLY: '1' })).toBeNull()
  // PATH 에 있으면 찾는다.
  expect(findExecutable('sh', { PATH: '/bin:/usr/bin', KNUAF_AGENT_PATH_ONLY: '1' })).toBe('/bin/sh')
  // 표식이 없으면 지금까지처럼 사용자 설치 위치도 본다(홈 아래 임시 설치로 확인).
  const home = mkdtempSync(join(tmpdir(), 'kd-bin-'))
  const binDir = join(home, '.local', 'bin')
  mkdirSync(binDir, { recursive: true })
  const fake = join(binDir, 'knuaf-probe-tool')
  writeFileSync(fake, '#!/bin/sh\nexit 0\n', 'utf-8'); chmodSync(fake, 0o755)
  expect(findExecutable('knuaf-probe-tool', { PATH: '', HOME: home })).toBe(fake)
  expect(findExecutable('knuaf-probe-tool', { PATH: '', HOME: home, KNUAF_AGENT_PATH_ONLY: '1' })).toBeNull()
})

// ---------------------------------------------------------------- Claude 확인 실패

/** `auth status` 를 흉내 내는 가짜 CLI. 실제 claude 는 띄우지 않는다. */
function fakeClaudeCli(body: string, opts: { sleep?: number } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'kd-claude-'))
  const file = join(dir, 'claude')
  const script = opts.sleep
    ? `#!/bin/sh\nsleep ${opts.sleep}\n`
    : `#!/bin/sh\nprintf '%s\\n' '${body}'\n`
  writeFileSync(file, script, 'utf-8')
  chmodSync(file, 0o755)
  return file
}

function claude(binary: string, statusTimeoutMs?: number): ClaudeConnection {
  const options: AgentOptions = { binary, root: tmpdir(), skill: source, env: {}, openExternal: async () => {}, statusTimeoutMs }
  return new ClaudeConnection(options)
}

test('구독 로그인이 안 된 정상 응답은 확인 성공 + 미연결이다', async () => {
  const cli = fakeClaudeCli(JSON.stringify({ loggedIn: false, authMethod: null, apiProvider: null }))
  expect(await claude(cli).status()).toMatchObject({ installed: true, connected: false, probe: 'ok' })
})

test('구독 로그인이 확인되면 연결됨이다', async () => {
  const cli = fakeClaudeCli(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }))
  expect(await claude(cli).status()).toMatchObject({ installed: true, connected: true, probe: 'ok' })
  // API 키 경로는 구독 연결이 아니다.
  const api = fakeClaudeCli(JSON.stringify({ loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty' }))
  expect(await claude(api).status()).toMatchObject({ connected: false, probe: 'ok' })
})

test('시간 초과는 로그인 필요가 아니라 확인 실패다', async () => {
  const cli = fakeClaudeCli('', { sleep: 5 })
  const st = await claude(cli, 300).status()
  expect(st.probe).toBe('failed')
  expect(st.connected).toBe(false)
  expect(connInfoOf(st).state).toBe('failed')
})

test('망가진 JSON 도 확인 실패다', async () => {
  const cli = fakeClaudeCli('이건 JSON 이 아니에요')
  const st = await claude(cli).status()
  expect(st.probe).toBe('failed')
  expect(connInfoOf(st).state).toBe('failed')
})

test('실행되지 않는 CLI 도 확인 실패다', async () => {
  const st = await claude(join(tmpdir(), 'kd-no-such-claude')).status()
  expect(st.probe).toBe('failed')
  expect(st.connected).toBe(false)
})

// ---------------------------------------------------------------- 전역 연결 (폴더 없이)

function fake(over: Partial<AgentConnection> = {}): AgentConnection {
  return {
    status: async () => ({ installed: true, connected: true, version: '0.0.0-test', detail: 'fake' }),
    login: async () => {},
    run: async () => {},
    respond: () => {},
    stop: async () => {},
    ...over
  }
}

/**
 * `options.root` 로 가짜 연결을 만들어 준다 — 폴더 연결과 전역 연결이 실제로 다른
 * 연결인지 보려면 어느 root 로 만들어졌는지가 보여야 한다.
 */
function service(factory?: (provider: 'codex' | 'claude', options: AgentOptions) => AgentConnection) {
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const svc = new ChatService({
    skillSource: source, userData, emit: () => {}, openExternal: async () => {},
    connectionFactory: factory ?? ((_p, options) => fake({ status: async () => ({ installed: true, connected: options.root.includes('connect-probe'), version: null, detail: '' }) }))
  })
  return { svc, userData }
}

test('전역 연결은 폴더 없이 상태를 확인한다', async () => {
  const { svc, userData } = service()
  const st = await svc.globalStatus('codex')
  expect(st.connected).toBe(true)
  // cwd 는 userData 아래 빈 폴더 — 논문 폴더가 없어도 CLI 가 설 자리가 있다.
  expect(existsSync(join(userData, 'connect-probe'))).toBe(true)
  await svc.close()
})

test('전역 연결은 폴더 연결과 섞이지 않는다', async () => {
  const roots: string[] = []
  const { svc } = service((_p, options) => {
    roots.push(options.root)
    // 전역 연결(connect-probe)만 연결됨으로 답한다.
    return fake({ status: async () => ({ installed: true, connected: options.root.includes('connect-probe'), version: null, detail: '' }) })
  })
  const project = mkdtempSync(join(tmpdir(), 'kd-proj-'))
  expect((await svc.globalStatus('codex')).connected, '전역 연결이 먼저 봐야 한다').toBe(true)
  expect((await svc.status(project, 'codex')).connected, '폴더 연결은 따로 답한다').toBe(false)
  expect(roots).toHaveLength(2)
  expect(roots[0]).toContain('connect-probe')
  expect(roots[1]).toBe(project)
  await svc.close()
})

test('전역 연결로는 아무것도 보낼 수 없다', async () => {
  // 파일을 쓰는 일(스킬 설치)은 send() 안에서만 일어난다. 전역 연결이 run 에 닿지 못하면
  // 첫 화면이 논문 폴더에 흔적을 남기지 않는다는 성질이 코드로 지켜진다.
  const ran: string[] = []
  const { svc } = service((_p, options) => fake({ run: async () => { ran.push(options.root) } }))
  await svc.globalStatus('codex')
  await svc.globalLogin('codex')
  expect(ran, '전역 연결의 run 이 불렸다').toEqual([])
  await svc.close()
})

test('로그인이 끝나면 연결됨, 취소하면 다시 로그인이 필요하다', async () => {
  let loggedIn = false
  let cancelled = false
  // 취소 뒤에는 연결을 버리므로 상태는 팩토리 바깥(클로저)에 둔다 — 새 연결도 같은 계정 상태를 본다.
  const { svc } = service(() => fake({
    status: async () => ({ installed: true, connected: loggedIn, version: null, detail: '', probe: 'ok' as const }),
    login: async () => { loggedIn = true },
    cancelLogin: async () => { cancelled = true; loggedIn = false }
  }))
  expect((await svc.globalStatus('codex')).connected).toBe(false)
  await svc.globalLogin('codex')
  expect((await svc.globalStatus('codex')).connected).toBe(true)
  await svc.cancelLogin('codex')
  expect(cancelled, '취소가 연결에 닿지 않았다').toBe(true)
  const after = await svc.globalStatus('codex')
  expect(after.connected).toBe(false)
  expect(connInfoOf(after).state, '취소 뒤에는 로그인이 필요하다').toBe('need-login')
  await svc.close()
})

test('취소 메서드가 없는 연결은 닫는 것으로 취소한다', async () => {
  let stopped = false
  const { svc } = service(() => fake({ stop: async () => { stopped = true } }))
  await svc.globalLogin('codex')
  await svc.cancelLogin('codex')
  expect(stopped).toBe(true)
  await svc.close()
})

test('도구가 없으면 전역 확인은 도구 없음이다', async () => {
  const { svc } = service(() => fake({ status: async () => ({ installed: false, connected: false, version: null, detail: '설치 안내를 열어 준비한 뒤 다시 확인해 주세요.' }) }))
  const st = await svc.globalStatus('claude')
  expect(st.installed).toBe(false)
  expect(connInfoOf(st).state).toBe('no-tool')
  await svc.close()
})

test('핸드셰이크가 실패하면 전역 확인은 확인 실패다', async () => {
  // Codex 는 연결 실패를 예외로 올린다(account/read 실패 포함). 전역 IPC 가 그 예외를
  // probe:'failed' 로 바꾼다 — 예외가 그대로 올라가면 화면이 아무 상태도 못 그린다.
  const { svc } = service(() => fake({ status: async () => { throw new Error('Codex와 연결하지 못했어요.') } }))
  const st = await svc.globalStatus('codex')
  expect(st).toMatchObject({ installed: true, connected: false, probe: 'failed' })
  expect(st.detail).toContain('연결하지 못했')
  expect(connInfoOf(st).state).toBe('failed')
  await svc.close()
})

test('다시 열기는 로그인 주소를 다시 연다', async () => {
  const opened: string[] = []
  const { svc } = service(() => fake({
    login: async () => {},
    reopenLogin: async () => { opened.push('reopened') }
  }))
  await svc.globalLogin('codex')
  await svc.reopenLogin('codex')
  expect(opened).toEqual(['reopened'])
  await svc.close()
})
