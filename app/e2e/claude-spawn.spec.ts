// 실제 SDK + 가짜 자식 프로세스. 로그인·모델 호출·Electron 화면 조작은 하지 않는다.
import { expect, test } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mock } from 'node:test'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ClaudeConnection } from '../src/main/chat/claude'
import { claudeSpawnOptions } from '../src/main/chat/claude-spawn'
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk'

const cp = require('node:child_process') as typeof import('node:child_process')
const win = require('../src/main/win') as typeof import('../src/main/win')
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

test.afterEach(() => {
  mock.restoreAll()
  Object.defineProperty(process, 'platform', platform)
})

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: 12345, killed: false, exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => true
  })
}

test('W1-2: Windows batch shim에만 SDK spawner를 지정한다', () => {
  for (const binary of ['C:\\npm\\claude.cmd', 'C:\\npm\\claude.BAT']) {
    expect(claudeSpawnOptions(binary, 'win32').spawnClaudeCodeProcess).toBeInstanceOf(Function)
    expect(claudeSpawnOptions(binary, 'darwin')).toEqual({})
    expect(claudeSpawnOptions(binary, 'linux')).toEqual({})
  }
  expect(claudeSpawnOptions('C:\\bin\\claude.exe', 'win32')).toEqual({})
  expect(claudeSpawnOptions('/usr/local/bin/claude', 'darwin')).toEqual({})
})

test('W1-2: run의 실제 SDK 인자는 cmd.exe로 가고 본문·추가 지시문은 stdin으로 간다', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  const child = fakeChild()
  const spawned: { command: string; args: string[]; options: any }[] = []
  mock.method(cp, 'spawn', (command: string, args: string[], options: any) => {
    // 수정 전 SDK 기본 spawn은 여기에 .cmd를 그대로 넘긴다.
    expect(command).toMatch(/(?:^|[\\/])cmd\.exe$/i)
    spawned.push({ command, args, options })
    return child
  })
  const input: any[] = []
  let pending = ''
  child.stdin.on('data', (chunk) => {
    pending += chunk.toString()
    let end: number
    while ((end = pending.indexOf('\n')) >= 0) {
      const msg = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1)
      input.push(msg)
      if (msg.type === 'control_request' && msg.request.subtype === 'initialize') {
        child.stdout.write(JSON.stringify({ type: 'control_response', response: {
          subtype: 'success', request_id: msg.request_id,
          response: { commands: [{ name: 'knuaf-dev' }], account: { apiKeySource: 'none' } }
        } }) + '\n')
      } else if (msg.type === 'user') {
        setImmediate(() => {
          child.stdout.write(JSON.stringify({ type: 'assistant', uuid: 'answer', session_id: 'session', message: {
            content: [{ type: 'text', text: '가짜 응답' }]
          } }) + '\n')
          child.stdout.end(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'session' }) + '\n')
          child.exitCode = 0
          child.emit('exit', 0, null); child.stderr.end(); child.emit('close', 0, null)
        })
      }
    }
  })
  const binary = 'C:\\Users\\학생 이름\\AppData\\Roaming\\npm\\claude.cmd'
  const env = { W1_TEST: 'isolated', KNUAF_CLAUDE_MODEL: 'sonnet', KNUAF_CLAUDE_EFFORT: 'high' }
  const conn = new ClaudeConnection({ binary, root: 'C:\\논문 폴더', env, skill: '', openExternal: async () => {} })
  // 상태 확인은 앞선 W1의 별도 시험 범위. 이번 시험은 run → SDK → spawn 전체를 돈다.
  mock.method(conn, 'status', async () => ({ installed: true, connected: true, version: null, detail: '' }))
  const messages: string[] = []
  const events = { skill: () => {}, session: () => {}, message: (_id: string, text: string) => messages.push(text), permission: () => {}, note: () => {} }
  const text = '진행률 100%\n공백과 & 기호를 유지해 주세요.'
  await conn.run(text, undefined, events)
  expect(messages).toEqual(['가짜 응답'])
  expect(spawned).toHaveLength(1)
  const spec = spawned[0]
  expect(spec.args.slice(0, 4)).toEqual(['/v:off', '/d', '/s', '/c'])
  expect(spec.options).toMatchObject({ cwd: 'C:\\논문 폴더', env: { W1_TEST: 'isolated' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true })
  expect(spec.options.signal, 'Node가 cmd.exe만 죽이는 signal 경로는 쓰지 않는다').toBeUndefined()
  expect(spec.args[4]).toContain('--output-format')
  expect(spec.args[4]).toContain('sonnet')
  expect(spec.args[4]).not.toContain('100%')
  expect(spec.args[4]).not.toContain('개인용 knuaf-dev GUI')
  expect(input.find(m => m.type === 'user').message.content).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'text', text: expect.stringContaining(text) })
  ]))
  expect(input.find(m => m.request?.subtype === 'initialize').request.appendSystemPrompt).toContain('개인용 knuaf-dev GUI')
})

test('W1-2: forwarded abort와 SDK kill은 killTree로 가고 close 뒤 신호는 해제한다', () => {
  const children = [fakeChild(), fakeChild()]
  mock.method(cp, 'spawn', () => children.shift())
  const kills: unknown[][] = []
  mock.method(win, 'killTree', (...args: unknown[]) => { kills.push(args) })
  const opts = (signal: AbortSignal): SpawnOptions => ({ command: 'C:\\npm\\claude.cmd', args: ['--verbose'], env: {}, cwd: 'C:\\논문', signal })
  const spawn = claudeSpawnOptions('C:\\npm\\claude.cmd', 'win32').spawnClaudeCodeProcess!
  const controller = new AbortController()
  const first = children[0]
  const process = spawn(opts(controller.signal))
  expect(first.stderr.readableFlowing).toBe(true)
  controller.abort()
  expect(kills).toEqual([[first, 'SIGTERM']])
  expect(process.killed).toBe(true)
  process.kill('SIGKILL')
  expect(kills[1]).toEqual([first, 'SIGKILL'])

  const late = new AbortController()
  const second = children[0]
  spawn(opts(late.signal))
  second.emit('close', 0, null)
  late.abort()
  expect(kills).toHaveLength(2)
})

test('W1-2: cmd로 표현 불가능한 SDK 인자는 자식을 띄우기 전에 거절한다', () => {
  const spawned = mock.method(cp, 'spawn', () => { throw new Error('spawn에 도착하면 안 된다') })
  const spawn = claudeSpawnOptions('C:\\npm\\claude.bat', 'win32').spawnClaudeCodeProcess!
  for (const arg of ['100%', 'a\nb', 'a\0b']) {
    expect(() => spawn({ command: 'C:\\npm\\claude.bat', args: [arg], env: {}, signal: new AbortController().signal })).toThrow(/cmd.exe/)
  }
  expect(spawned.mock.callCount()).toBe(0)
})

test('W1-2: 실제 가짜 CLI로 status → 첫 대화 → 이어 대화가 끝난다 (Windows는 npm형 shim)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-claude-query-'))
  const fixture = resolve(__dirname, 'fixtures/fake-claude-query.mjs')
  const binary = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const log = join(root, 'query.jsonl')
  writeFileSync(binary, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${fixture.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 })
  const conn = new ClaudeConnection({ binary, root, skill: '', openExternal: async () => {},
    env: { ...process.env, W1_QUERY_LOG: log } })
  const messages: string[] = []
  const events = { skill: () => {}, session: () => {}, message: (_id: string, text: string) => messages.push(text), permission: () => {}, note: () => {} }
  try {
    expect(await conn.status()).toMatchObject({ connected: true, probe: 'ok' })
    await conn.run('진행률 100%\n한글과 & 기호', undefined, events)
    await conn.run('이어서 50%\n다음 줄', 'fake-session', events)
    expect(messages).toEqual(['가짜 CLI 응답', '가짜 CLI 응답'])
    const rows = readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s))
    const launches = rows.filter(r => r.args)
    expect(launches).toHaveLength(2)
    expect(launches[1].args).toContain('--resume=fake-session')
    expect(launches.every(r => realpathSync(r.cwd) === realpathSync(root))).toBe(true)
    expect(rows.filter(r => r.type === 'user')[1].message.content).toEqual([
      { type: 'text', text: '이어서 50%\n다음 줄' }
    ])
  } finally { await conn.stop() }
})
