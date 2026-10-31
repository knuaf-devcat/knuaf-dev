// 폴더 없는 AI 연결(단계 2)의 Node 단위 시험 — 가짜 연결·가짜 CLI만 쓴다.
// 실제 로그인도 실제 AI 호출도 하지 않는다. `codex app-server`·`claude` 는 여기서 띄우지 않는다.
import { expect, test } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { ClaudeConnection } from '../src/main/chat/claude'
import { findExecutable, skillSource } from '../src/main/agent'
import { writeCliShim } from './fixtures/fake-codex'
import { canAdvance, connInfoOf, nextProvider, displayState, useConnect, type ConnInfo } from '../src/renderer/src/store/connect'
import { useChat } from '../src/renderer/src/store/chat'
import type { AgentConnection, AgentOptions } from '../src/main/chat/contracts'
import type { ConnectionStatus, Provider } from '../src/shared/chat'

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

test('첫 실행의 전진 조건은 고른 것이 지금 연결돼 있을 때만 참이다 (P2-R1-03)', () => {
  // 저장된 선택은 "고른 적 있음"일 뿐이다 — 연결을 못 마쳤으면 [다음] 으로 넘어갈 수 없다.
  for (const s of ['checking', 'no-tool', 'need-login', 'logging-in', 'failed', 'unknown'] as const) {
    expect(canAdvance('claude', () => s), s).toBe(false)
  }
  expect(canAdvance('claude', () => 'connected')).toBe(true)
  expect(canAdvance(null, () => 'connected'), '고른 것이 없으면 넘어갈 수 없다').toBe(false)
})

test('첫 실행 [다음] 은 연결된 AI 하나를 기록한다 — 고른 것이 연결돼 있으면 그대로 둔다', () => {
  const order = ['codex', 'claude'] as const
  const only = (on: Provider) => (p: Provider) => (p === on ? 'connected' as const : 'need-login' as const)
  // 연결된 것이 없으면 [다음] 이 닫힌다.
  expect(nextProvider(null, order, () => 'need-login')).toBeNull()
  expect(nextProvider('claude', order, () => 'checking')).toBeNull()
  // 고른 적이 없고 둘 다 연결 — 행 순서(권장이 먼저)의 첫째.
  expect(nextProvider(null, order, () => 'connected')).toBe('codex')
  // 고른 것이 연결돼 있으면 다른 쪽이 연결돼 있어도 바꾸지 않는다.
  expect(nextProvider('claude', order, () => 'connected')).toBe('claude')
  // 고른 것이 끊겨 있으면 연결된 쪽으로 넘어간다 — 연결 안 된 선택으로 폴더 단계에 서지 않는다.
  expect(nextProvider('claude', order, only('codex'))).toBe('codex')
  expect(nextProvider(null, order, only('claude'))).toBe('claude')
})

// ---------------------------------------------------------------- 실행 파일 찾기

test('KNUAF_AGENT_PATH_ONLY=1 이면 PATH 만 본다', () => {
  // 호스트 규칙과 Windows 규칙을 함께 검사한다. Windows에서는 중복 없이 한 번 돈다.
  for (const platform of new Set<NodeJS.Platform>([process.platform, 'win32'])) {
    const win = platform === 'win32'
    const separator = win ? ';' : delimiter
    const filename = win ? 'knuaf-probe-tool.cmd' : 'knuaf-probe-tool'
    const body = win ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n'
    // Finder 로 띄운 앱처럼 PATH 가 비어 있으면 아무것도 찾지 못한다 — 개발 기계에
    // 진짜 codex 가 깔려 있어도 "도구 없음" 화면을 재현할 수 있어야 한다.
    expect(findExecutable('codex', { PATH: '', HOME: tmpdir(), KNUAF_AGENT_PATH_ONLY: '1' }, { platform })).toBeNull()
    // PATH 에 있으면 찾는다 — 항목 구분자는 플랫폼마다 다르다(`:` vs `;`).
    const onPath = mkdtempSync(join(tmpdir(), 'kd-path-'))
    const probe = join(onPath, filename)
    writeFileSync(probe, body, 'utf-8')
    chmodSync(probe, 0o755)   // POSIX 는 실행 비트가 있어야 executable — 윈도우에서는 no-op
    expect(findExecutable('knuaf-probe-tool', { PATH: ['/nonexistent-first', onPath].join(separator), KNUAF_AGENT_PATH_ONLY: '1' }, { platform })).toBe(probe)
    // 표식이 없으면 지금까지처럼 사용자 설치 위치도 본다(홈 아래 임시 설치로 확인).
    const home = mkdtempSync(join(tmpdir(), 'kd-bin-'))
    const binDir = join(home, '.local', 'bin')
    mkdirSync(binDir, { recursive: true })
    const fake = join(binDir, filename)
    writeFileSync(fake, body, 'utf-8'); chmodSync(fake, 0o755)
    expect(findExecutable('knuaf-probe-tool', { PATH: '', HOME: home }, { platform })).toBe(fake)
    expect(findExecutable('knuaf-probe-tool', { PATH: '', HOME: home, KNUAF_AGENT_PATH_ONLY: '1' }, { platform })).toBeNull()
  }
})

// ---------------------------------------------------------------- Claude 확인 실패

/** `auth status` 를 흉내 내는 가짜 CLI. 실제 claude 는 띄우지 않는다. */
function fakeClaudeCli(body: string, opts: { sleep?: number } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'kd-claude-'))
  const win = process.platform === 'win32'
  // 셔뱅은 유닉스에만 있다 — 윈도우는 `.cmd` 감싸개(`claude.cmd`)로 둔다.
  const file = join(dir, win ? 'claude.cmd' : 'claude')
  const script = win
    ? (opts.sleep ? '@echo off\r\nping -n 6 127.0.0.1 >nul\r\n' : `@echo off\r\necho ${body}\r\n`)
    : (opts.sleep ? `#!/bin/sh\nsleep ${opts.sleep}\n` : `#!/bin/sh\nprintf '%s\\n' '${body}'\n`)
  writeFileSync(file, script, 'utf-8')
  if (!win) chmodSync(file, 0o755)
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
    skillSource: () => source, userData, emit: () => {}, openExternal: async () => {},
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

test('종료 시작 뒤 기존·새 프로젝트와 전역 상태 확인은 연결을 만들지 않는다', async () => {
  const roots: string[] = []
  const stopped: string[] = []
  let probes = 0
  const { svc } = service((_p, options) => {
    roots.push(options.root)
    return fake({
      status: async () => { probes += 1; return status({ connected: true }) },
      stop: async () => { stopped.push(options.root) }
    })
  })
  const project = mkdtempSync(join(tmpdir(), 'kd-proj-'))
  const other = mkdtempSync(join(tmpdir(), 'kd-proj-'))
  await svc.globalStatus('codex')
  await svc.status(project, 'codex')
  expect(roots).toHaveLength(2)
  expect(probes).toBe(2)
  svc.beginShutdown()
  await expect(svc.status(project, 'codex')).rejects.toThrow('앱을 종료하고 있어요')
  await expect(svc.status(other, 'codex')).rejects.toThrow('앱을 종료하고 있어요')
  await expect(svc.globalStatus('codex')).rejects.toThrow('앱을 종료하고 있어요')
  await expect(svc.globalStatus('claude')).rejects.toThrow('앱을 종료하고 있어요')
  expect(roots).toHaveLength(2)
  expect(probes).toBe(2)
  await svc.close()
  expect(stopped.sort()).toEqual(roots.sort())
  await expect(svc.status(other, 'codex')).rejects.toThrow('앱을 종료하고 있어요')
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

// ---------------------------------------------------------------- 로그인 프로세스 소유권

/** 살아 있는지 — 신호 0 은 죽이지 않고 존재만 본다. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
async function until(ok: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 20)) }
  return ok()
}

test('다시 열기 뒤 취소는 새 로그인 프로세스까지 끝낸다 (P2-R1-02)', async () => {
  // 오래 살아 있는 가짜 로그인 CLI. PID 는 **연결이 기록한** `loginProcess.pid` 를 읽는다 —
  // 윈도우 배치는 자기 PID 를 쓸 수 없고(`%PROCESSID%` 가 없다), 우리가 보는 것은 자식
  // 프로세스 자체(cmd.exe)의 생사다. 본문은 유닉스 `sleep`, 윈도우는 **절대경로 node** 로
  // 살아만 있는다(PATH·셸 도구에 기대지 않는다 — CI 3차에서 `ping` 이 좁은 PATH 에 없어 죽었다).
  const dir = mkdtempSync(join(tmpdir(), 'kd-claude-'))
  writeCliShim(dir, 'claude', 'exec sleep 300', `"${process.execPath}" -e "setTimeout(()=>{},60000)"`)
  const cli = join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const options: AgentOptions = { binary: cli, root: dir, skill: source, env: {}, openExternal: async () => {} }
  const conn = new ClaudeConnection(options)
  const pidOf = (): number | undefined => (conn as unknown as { loginProcess?: { pid?: number } }).loginProcess?.pid
  try {
    await conn.login()                                   // A
    const a = pidOf()
    expect(a, '로그인 프로세스가 뜨지 않았다').toBeTruthy()
    await conn.reopenLogin()                             // A 를 끝내고 B 를 띄운다
    expect(await until(() => !alive(a!)), '이전 프로세스가 끝나지 않았다').toBe(true)
    // 이전 자식(A)의 종료가 **살아 있는 새 자식(B)** 의 추적을 지우면 안 된다.
    const b = pidOf()
    expect(b, '살아 있는 새 프로세스의 추적이 사라졌다').toBeTruthy()
    expect(b).not.toBe(a)
    expect(alive(b!), '새 로그인 프로세스가 살아 있지 않다').toBe(true)
    await conn.cancelLogin()
    expect(await until(() => !alive(b!)), '취소가 새 로그인 프로세스를 죽이지 않았다').toBe(true)
    expect(pidOf()).toBeUndefined()
  } finally {
    await conn.stop()
  }
})

// ---------------------------------------------------------------- 취소한 로그인 시도

/** 타이머를 세는 가짜 시계 — 공급자별 폴링이 서로를 지우는지 본다. */
function countingTimers(): { timers: Set<unknown>; restore: () => void } {
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const timers = new Set<unknown>()
  globalThis.setInterval = ((fn: () => void, ms?: number) => { const t = realSetInterval(fn, ms); timers.add(t); return t }) as unknown as typeof setInterval
  globalThis.clearInterval = ((t?: unknown) => { timers.delete(t); return realClearInterval(t as never) }) as unknown as typeof clearInterval
  return { timers, restore: () => { for (const t of timers) realClearInterval(t as never); globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval } }
}

/**
 * 연결 IPC 대역 — 로그인은 **공급자별로 보류**해 두고, 시험이 원하는 순서로 성공시킨다.
 * `status` 는 늘 "아직 연결 안 됨"이라고 답한다(폴링이 스스로 끝나지 않게).
 */
function pendingConnections(): {
  release: (provider: Provider, value: unknown) => void
  restore: () => void
} {
  const waiting = new Map<Provider, (v: unknown) => void>()
  const realWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    knuaf: { connect: {
      status: async () => ({ result: { installed: true, connected: false, version: null, detail: '', probe: 'ok' } }),
      login: (provider: Provider) => new Promise((resolve) => { waiting.set(provider, resolve) }),
      cancel: async () => ({ result: true }),
      reopen: async () => ({ result: true })
    } }
  }
  return {
    release: (provider, value) => { waiting.get(provider)?.(value) },
    restore: () => { (globalThis as { window?: unknown }).window = realWindow }
  }
}

test('한 공급자의 로그인 시작은 다른 공급자의 폴링·시도 번호를 건드리지 않는다 (W2 D1)', async () => {
  // W1 재현 ②: Claude 로그인을 시작하는 것만으로 GPT 의 로그인 응답이 무효가 되고 폴링이
  // 사라져, GPT 가 실제로 연결됐는데도 행이 "로그인 중"에 멈췄다.
  const clock = countingTimers()
  const ipc = pendingConnections()
  try {
    const store = useConnect.getState()
    store.stopPolling()
    const codexRun = store.login('codex')
    await new Promise((r) => setTimeout(r, 0))
    const claudeRun = store.login('claude')
    await new Promise((r) => setTimeout(r, 0))
    expect(useConnect.getState().loggingIn, '두 로그인이 동시에 진행 중이어야 한다').toEqual({ codex: true, claude: true })

    ipc.release('codex', { result: true })
    await codexRun
    // GPT 응답이 버려지지 않았다 — 그 공급자의 폴링이 생겼다.
    expect(clock.timers.size, 'GPT 로그인 응답이 Claude 시작 때문에 버려졌다').toBe(1)
    ipc.release('claude', { result: true })
    await claudeRun
    // 둘 다 저마다의 타이머를 갖는다 — 하나가 다른 하나를 지우지 않는다.
    expect(clock.timers.size).toBe(2)
  } finally {
    useConnect.getState().stopPolling()
    clock.restore()
    ipc.restore()
  }
})

test('한 공급자 취소는 다른 공급자의 폴링을 멈추지 않는다 (W2 D1)', async () => {
  const clock = countingTimers()
  const ipc = pendingConnections()
  try {
    const store = useConnect.getState()
    store.stopPolling()
    const codexRun = store.login('codex')
    await new Promise((r) => setTimeout(r, 0))
    ipc.release('codex', { result: true })
    await codexRun
    const claudeRun = store.login('claude')
    await new Promise((r) => setTimeout(r, 0))
    ipc.release('claude', { result: true })
    await claudeRun
    expect(clock.timers.size).toBe(2)

    await store.cancel('codex')
    expect(useConnect.getState().loggingIn.codex).toBe(false)
    expect(clock.timers.size, 'GPT 취소가 Claude 의 기다림까지 끊었다').toBe(1)
  } finally {
    useConnect.getState().stopPolling()
    clock.restore()
    ipc.restore()
  }
})

/** 손으로 돌리는 타이머 — 콜백을 모아 두고 시험이 원하는 순서로 한 번씩 돌린다. */
function manualTimers(): { timers: Map<unknown, () => void>; runAll: () => Promise<void>; restore: () => void } {
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const timers = new Map<unknown, () => void>()
  globalThis.setInterval = ((fn: () => void) => { const t = {}; timers.set(t, fn); return t }) as unknown as typeof setInterval
  globalThis.clearInterval = ((t?: unknown) => { timers.delete(t); return 0 }) as unknown as typeof clearInterval
  return {
    timers,
    runAll: async () => {
      for (const fn of [...timers.values()]) fn()
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))   // tick 의 await 를 흘려보낸다
    },
    restore: () => { globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval }
  }
}

test('같은 방문에서 팝오버 로그인으로 대체된 폴더 로그인도 busy 를 남기지 않는다 (R2-C01 2차)', async () => {
  // 확인 판정서의 1~4 순서 그대로: 폴더 로그인 보류 → (폴더·공급자 그대로) 팝오버가 같은
  // 공급자로 새 로그인 시작·성공 → 옛 폴더 응답 해제 → 새 감시가 연결을 확인해 로그인 완료.
  // 조기 반환이 `busy` 해제까지 건너뛰면, 로그인은 끝났는데도 보내기·로그인·다시 확인이 잠긴다.
  const clock = manualTimers()
  const realWindow = (globalThis as { window?: unknown }).window
  let releaseChatLogin: (v: unknown) => void = () => {}
  const chatLogin = new Promise<unknown>((resolve) => { releaseChatLogin = resolve })
  let releaseConnectLogin: (v: unknown) => void = () => {}
  const connectLogin = new Promise<unknown>((resolve) => { releaseConnectLogin = resolve })
  /** 폴링 tick 이 물을 때 답 — 3단계에서 로그인이 끝난 뒤로 바뀐다. */
  let connected = false
  const status = () => ({ result: { installed: true, connected, version: null, detail: '', probe: 'ok' } })
  ;(globalThis as { window?: unknown }).window = {
    knuaf: {
      chat: {
        login: () => chatLogin,
        snapshot: async () => ({ result: { root: '/fake/paper', provider: 'codex', state: 'idle', messages: [] } }),
        status: async () => status(),
        draft: async () => ({ result: '' })
      },
      connect: {
        status: async () => status(),
        login: () => connectLogin,
        cancel: async () => ({ result: true }),
        reopen: async () => ({ result: true })
      }
    }
  }
  const chatBefore = useChat.getState()
  try {
    useConnect.getState().stopPolling()
    useChat.setState({ root: '/fake/paper', provider: 'codex', visit: 0, busy: false })

    // ① 폴더 화면의 로그인 — 응답을 보류한다.
    const folderLogin = useChat.getState().login()
    await new Promise((r) => setTimeout(r, 0))
    expect(useChat.getState().busy, '폴더 로그인이 시작되지 않았다').toBe(true)

    // ② 폴더도 공급자도 그대로인 채, 계정 팝오버가 같은 공급자로 새 로그인을 시작해 성공한다.
    const popoverLogin = useConnect.getState().login('codex')
    await new Promise((r) => setTimeout(r, 0))
    releaseConnectLogin({ result: true })
    await popoverLogin
    expect(clock.timers.size, '새 로그인의 감시가 생기지 않았다').toBe(1)

    // ③ 이제야 ①의 옛 응답이 도착한다 — 폴링은 새 시도의 것이므로 만들지 않는다.
    releaseChatLogin({ result: true })
    await folderLogin
    expect(clock.timers.size, '옛 응답이 새 감시를 갈아 끼웠다').toBe(1)
    expect(useChat.getState().busy, '대체된 폴더 로그인이 busy 를 남겼다').toBe(false)

    // ④ 새 감시가 연결을 확인하면 로그인이 끝난다 — 감시도 표시도 남지 않는다.
    connected = true
    await clock.runAll()
    expect(clock.timers.size, '연결을 확인한 감시가 남았다').toBe(0)
    expect(useConnect.getState().loggingIn.codex).toBe(false)
    expect(useConnect.getState().codex.state).toBe('connected')
    expect(useChat.getState().busy).toBe(false)
  } finally {
    useConnect.getState().stopPolling()
    useChat.setState({ ...chatBefore, visit: 0, busy: false })
    clock.restore()
    ;(globalThis as { window?: unknown }).window = realWindow
  }
})

test('폴더 로그인의 옛 응답은 계정 팝오버가 시작한 새 감시를 갈아 끼우지 않는다 (R2-C01)', async () => {
  // 판정서 R2-C01 의 순서 그대로: 폴더 로그인 응답을 보류 → 공급자 전환 → 새 connect.login 성공
  // → 옛 응답 해제. 옛 코드는 여기서 startPoll 을 불러 새 타이머를 교체했고, 그 타이머는 첫 tick
  // 에서 "공급자가 바뀌었다"를 보고 스스로 꺼져 감시가 0개가 됐다.
  const clock = manualTimers()
  const realWindow = (globalThis as { window?: unknown }).window
  let releaseChatLogin: (v: unknown) => void = () => {}
  const chatLogin = new Promise<unknown>((resolve) => { releaseChatLogin = resolve })
  let releaseConnectLogin: (v: unknown) => void = () => {}
  const connectLogin = new Promise<unknown>((resolve) => { releaseConnectLogin = resolve })
  const okStatus = { result: { installed: true, connected: false, version: null, detail: '', probe: 'ok' } }
  ;(globalThis as { window?: unknown }).window = {
    knuaf: {
      chat: {
        login: () => chatLogin,
        snapshot: async () => ({ result: { root: '/fake/paper', provider: 'claude', state: 'idle', messages: [] } }),
        status: async () => okStatus,
        draft: async () => ({ result: '' })
      },
      connect: {
        status: async () => okStatus,
        login: () => connectLogin,
        cancel: async () => ({ result: true }),
        reopen: async () => ({ result: true })
      }
    }
  }
  const chatBefore = useChat.getState()
  try {
    useConnect.getState().stopPolling()
    useChat.setState({ root: '/fake/paper', provider: 'codex', visit: 0, busy: false })

    const folderLogin = useChat.getState().login()
    await new Promise((r) => setTimeout(r, 0))
    expect(useChat.getState().busy, '폴더 로그인이 시작되지 않았다').toBe(true)

    // ② 그 사이 학생이 다른 공급자로 옮긴다.
    await useChat.getState().load('/fake/paper', 'claude')
    expect(useChat.getState().provider).toBe('claude')

    // ③ 계정 팝오버가 같은 공급자(codex)로 새 로그인을 시작해 성공한다 — 새 감시가 생긴다.
    const popoverLogin = useConnect.getState().login('codex')
    await new Promise((r) => setTimeout(r, 0))
    releaseConnectLogin({ result: true })
    await popoverLogin
    expect(clock.timers.size, '새 로그인의 감시가 생기지 않았다').toBe(1)

    // ④ 이제야 ①의 옛 응답이 도착한다.
    releaseChatLogin({ result: true })
    await folderLogin
    expect(clock.timers.size, '옛 응답이 새 감시를 갈아 끼웠다').toBe(1)

    // ⑤ 그 타이머를 한 번 돌려도 살아 있어야 한다 — 옛 코드는 여기서 스스로 꺼졌다.
    await clock.runAll()
    expect(clock.timers.size, '새 감시가 첫 tick 에서 사라졌다').toBe(1)
    expect(useConnect.getState().loggingIn.codex, '새 시도의 로그인 중 표시가 유지되지 않았다').toBe(true)
  } finally {
    useConnect.getState().stopPolling()
    useChat.setState({ ...chatBefore, visit: 0, busy: false })
    clock.restore()
    ;(globalThis as { window?: unknown }).window = realWindow
  }
})

test('취소 뒤 늦은 로그인 응답은 폴링을 되살리지 않는다 (P2-R1-04)', async () => {
  // 타이머를 세는 가짜 시계 — 취소 뒤에도 폴링이 남는지 본다.
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const timers = new Set<unknown>()
  globalThis.setInterval = ((fn: () => void, ms?: number) => { const t = realSetInterval(fn, ms); timers.add(t); return t }) as unknown as typeof setInterval
  globalThis.clearInterval = ((t?: unknown) => { timers.delete(t); return realClearInterval(t as never) }) as unknown as typeof clearInterval

  let release: (v: unknown) => void = () => {}
  const pending = new Promise<unknown>((resolve) => { release = resolve })
  const realWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    knuaf: { connect: {
      status: async () => ({ result: { installed: true, connected: false, version: null, detail: '', probe: 'ok' } }),
      login: () => pending,                                   // 보류 — 취소 뒤에 성공으로 온다
      cancel: async () => ({ result: true }),
      reopen: async () => ({ result: true })
    } }
  }
  try {
    const store = useConnect.getState()
    store.stopPolling()
    const started = store.login('codex')
    await new Promise((r) => setTimeout(r, 0))
    expect(useConnect.getState().loggingIn.codex, '로그인 시작이 표시되지 않았다').toBe(true)
    await store.cancel('codex')
    expect(timers.size, '취소 직후 타이머가 남았다').toBe(0)
    expect(useConnect.getState().loggingIn.codex).toBe(false)
    release({ result: true })                                  // 늦은 성공 응답
    await started
    expect(timers.size, '취소한 시도의 늦은 응답이 폴링을 되살렸다').toBe(0)
    expect(useConnect.getState().loggingIn.codex).toBe(false)
  } finally {
    for (const t of timers) realClearInterval(t as never)
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    ;(globalThis as { window?: unknown }).window = realWindow
  }
})
