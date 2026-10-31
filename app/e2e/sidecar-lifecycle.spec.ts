// Exercise the real bridge with controlled OS events/clock; no Electron or Python mocks in production.
import { expect, test } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import type { Sidecar } from '../src/main/sidecar'
import { skillSwitch } from '../src/main/update/switch'
import { agentActivity } from '../src/main/update/activity'

const source = transpileModule(readFileSync(join(__dirname, '../src/main/sidecar.ts'), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

class Child extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: string | null = null
  shutdown = true
  killMode: 'close' | 'exit' | 'ignore' | 'fail' = 'close'
  kills: string[] = []
  requests: { id: string; method: string }[] = []
  introspect = true
  stdin = new Writable({ write: (chunk, _encoding, callback) => {
    const request = JSON.parse(String(chunk))
    this.requests.push(request)
    if (request.method === 'shutdown') { if (this.shutdown) this.close() }
    else if (request.method === 'methods.list') { if (this.introspect) this.methods(request.id) }
    else if (request.method !== 'hold') this.line({ id: request.id, result: { pid: this.pid } })
    callback()
  } })
  constructor(readonly pid: number) { super() }
  line(message: object) { this.stdout.write(JSON.stringify(message) + '\n') }
  ready() { this.line({ event: 'ready', data: { pid: this.pid } }) }
  methods(id = this.requests.find(r => r.method === 'methods.list')!.id) {
    this.line({ id, result: [{ name: 'project.init', write: true }, { name: 'project.status', write: false }] })
  }
  exit(code = 0, signal: string | null = null) {
    this.exitCode = code; this.signalCode = signal
    this.emit('exit', code, signal)
  }
  close() {
    if (this.exitCode === null && this.signalCode === null) this.exit()
    this.stdout.end(); this.stderr.end()
    this.emit('close', this.exitCode, this.signalCode)
  }
  kill(signal = 'SIGTERM') {
    this.kills.push(signal)
    if (this.killMode === 'fail') return false
    if (this.killMode === 'close') this.close()
    if (this.killMode === 'exit') this.exit(0, signal)
    return true
  }
}

function harness(platform = 'darwin') {
  let now = 0
  let serial = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const children: Child[] = []
  const killers: Child[] = []
  const kills: { command: string; args: string[]; options: object }[] = []
  let scripts = '/scripts/S0'
  const spawnArgs: string[][] = []
  let automaticReady = true
  let failSpawn = false
  const exported: { exports: { Sidecar?: new () => Sidecar } } = { exports: {} }
  runInNewContext(source, {
    module: exported, exports: exported.exports, Promise,
    process: { platform, env: { SystemRoot: 'C:\\Windows' } },
    setTimeout: (fn: () => void, ms: number) => { const id = ++serial; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: (id: number) => timers.delete(id),
    require: (name: string) => {
      if (name === './update/switch') return { skillSwitch }
      if (name === './update/activity') return { agentActivity }
      if (name === './python') return {
        choosePython: (_root: string | null, override: string | null) => ({ python: override ?? 'base', kind: 'env' }),
        scriptsDir: () => scripts, sidecarDir: () => '/sidecar'
      }
      if (name === 'node:child_process') return { spawn: (command: string, args: string[], options: object) => {
        spawnArgs.push(args)
        const child = new Child(1000 + children.length + killers.length)
        if (command.endsWith('taskkill.exe')) {
          killers.push(child); kills.push({ command, args, options }); return child
        }
        if (failSpawn) {
          failSpawn = false
          queueMicrotask(() => { child.emit('error', new Error('ENOENT')); child.close() })
        } else if (automaticReady) queueMicrotask(() => child.ready())
        children.push(child)
        return child
      } }
      return require(name)
    }
  })
  const sidecar = new exported.exports.Sidecar!()
  return {
    sidecar, children, killers, kills,
    spawnArgs, setScripts: (path: string) => { scripts = path },
    manualReady: () => { automaticReady = false },
    failNextSpawn: () => { failSpawn = true },
    async advance(ms: number) {
      await flush()
      const end = now + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush()
      }
      now = end; await flush()
    }
  }
}

test('동시 configure는 옛 close까지 기다리고 새 실행기를 하나만 소유한다 (C-PY)', async () => {
  const h = harness()
  await h.sidecar.configure(null, 'base')
  const old = h.children[0]
  old.shutdown = false
  const first = h.sidecar.configure('/project', 'venv')
  const second = h.sidecar.configure('/project', 'venv')
  const rpc = h.sidecar.call<{ pid: number }>('project.status')
  await flush()
  old.exit() // delayed stdio close must not transfer ownership or start the second configure
  await flush()
  expect(h.children).toHaveLength(1)
  expect(h.sidecar.status().running).toBe(false)
  old.close()
  expect((await first).running).toBe(true)
  expect((await second).running).toBe(true)
  expect(h.children).toHaveLength(2)
  expect(await rpc).toEqual({ pid: h.children[1].pid })
  expect(h.sidecar.isWrite('project.init')).toBe(true)
  await h.sidecar.stop()
  expect(h.sidecar.status().running).toBe(false)
  expect(h.children.every(c => c.exitCode !== null)).toBe(true)
})

test('같은 실행기의 두 configure와 RPC는 ready와 메서드 탐색을 함께 기다린다', async () => {
  const h = harness(); h.manualReady()
  let completed = false
  const first = h.sidecar.configure('/project', 'venv')
  const second = h.sidecar.configure('/project', 'venv').then(value => { completed = true; return value })
  const rpc = h.sidecar.call<{ pid: number }>('project.status')
  await flush()
  expect(h.sidecar.status().running).toBe(false)
  const child = h.children[0]; child.introspect = false; child.ready()
  await flush()
  expect(completed).toBe(false)
  expect(child.requests.map(r => r.method)).toEqual(['methods.list'])
  child.methods()
  await first; await second
  expect(await rpc).toEqual({ pid: child.pid })
  expect(h.children).toHaveLength(1)
  await h.sidecar.stop()
})

test('이전 세대 이벤트는 새 요청·실행 상태를 덮지 않는다', async () => {
  const h = harness()
  await h.sidecar.configure(null, 'base')
  const old = h.children[0]
  // Captured callbacks model a late callback already queued by the old process.
  const oldExit = old.listeners('exit')[0]
  await h.sidecar.configure('/project', 'venv')
  const rpc = h.sidecar.call<{ revision: number }>('hold')
  await flush()
  const current = h.children[1]
  const id = current.requests.find(r => r.method === 'hold')!.id
  oldExit(0, null)
  expect(h.sidecar.status().running).toBe(true)
  current.line({ id, result: { revision: 7 } })
  expect(await rpc).toEqual({ revision: 7 })
  await h.sidecar.stop()
})

test('종료 6초 상한: 부모 exit와 공유 stdio 잔류는 격리되고 새 spawn을 막는다', async () => {
  const h = harness()
  await h.sidecar.configure('/project', 'base')
  const child = h.children[0]; child.shutdown = false; child.killMode = 'exit'
  const stopped = h.sidecar.stop()
  const failure = expect(stopped).rejects.toMatchObject({ code: 'sidecar_stop_timeout', data: { recovery: 'external_cleanup' } })
  await h.advance(5999)
  expect(h.sidecar.status().running).toBe(false)
  await h.advance(1); await failure
  expect(child.kills).toEqual(['SIGKILL'])
  await expect(h.sidecar.configure('/project', 'venv')).rejects.toMatchObject({ code: 'sidecar_stop_timeout' })
  await expect(h.sidecar.restart()).rejects.toMatchObject({ data: { recovery: 'external_cleanup' } })
  await expect(Promise.resolve(h.sidecar.call('sys.hello'))).rejects.toMatchObject({ code: 'sidecar_stop_timeout' })
  expect(h.children).toHaveLength(1)
  child.close() // late, valid confirmation releases ownership; not the timeout
  expect((await h.sidecar.configure('/project', 'venv')).running).toBe(true)
  await h.sidecar.stop()
})

test('live 격리는 명시적 restart로 같은 프로세스 종료부터 재시도한다', async () => {
  const h = harness()
  await h.sidecar.configure('/project', 'base')
  const child = h.children[0]; child.shutdown = false; child.killMode = 'ignore'
  const stopped = h.sidecar.stop()
  const failure = expect(stopped).rejects.toMatchObject({ code: 'sidecar_stop_timeout', data: { recovery: 'retry_stop' } })
  await h.advance(6000); await failure
  await expect(h.sidecar.configure('/project', 'venv')).rejects.toMatchObject({ data: { recovery: 'retry_stop' } })
  expect(h.children).toHaveLength(1)
  child.shutdown = true
  expect((await h.sidecar.restart()).running).toBe(true)
  expect(child.exitCode).toBe(0)
  expect(h.children).toHaveLength(2)
  await h.sidecar.stop()
})

test('spawn 실패 뒤 큐 회복, restart/stop/configure 교차에도 교착·중복 실행 없음', async () => {
  const h = harness(); h.failNextSpawn()
  await expect(h.sidecar.configure('/project', 'missing')).rejects.toMatchObject({ code: 'spawn_failed' })
  expect((await h.sidecar.configure('/project', 'venv')).running).toBe(true)
  const results = await Promise.allSettled([h.sidecar.restart(), h.sidecar.stop(), h.sidecar.configure('/project', 'venv')])
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'sidecar_start_cancelled' } })
  expect(results[1]).toMatchObject({ status: 'fulfilled' })
  expect(results[2]).toMatchObject({ status: 'fulfilled', value: { running: true } })
  expect(await h.sidecar.call('sys.hello')).toEqual({ pid: h.children.at(-1)!.pid })
  expect(h.children.filter(c => c.exitCode === null)).toEqual([h.children.at(-1)])
  await h.sidecar.stop()
})

test('Windows 강제종료는 taskkill 성공과 sidecar close를 모두 요구한다', async () => {
  const h = harness('win32')
  await h.sidecar.configure('/project', 'base')
  const child = h.children[0]; child.shutdown = false
  const stopped = h.sidecar.stop()
  let done = false; void stopped.then(() => { done = true })
  await h.advance(3000)
  expect(h.kills[0].args).toEqual(['/PID', String(child.pid), '/T', '/F'])
  expect(h.kills[0].options).toMatchObject({ shell: false, windowsHide: true })
  child.close()
  await flush()
  expect(done).toBe(false)
  h.killers[0].exit(0)
  await stopped
  expect((await h.sidecar.configure('/project', 'venv')).running).toBe(true)
  await h.sidecar.stop()
})

test('Windows taskkill 실패 뒤 close만 도착해도 새 spawn을 허용하지 않는다', async () => {
  const h = harness('win32')
  await h.sidecar.configure('/project', 'base')
  const child = h.children[0]; child.shutdown = false
  const stopped = h.sidecar.stop()
  const failure = expect(stopped).rejects.toMatchObject({ code: 'sidecar_stop_failed', data: { recovery: 'retry_stop' } })
  await h.advance(3000)
  h.killers[0].exit(1); await failure
  child.close()
  await expect(h.sidecar.restart()).rejects.toMatchObject({ code: 'sidecar_stop_failed', data: { recovery: 'external_cleanup' } })
  expect(h.children).toHaveLength(1)
})

test('Windows taskkill 자체가 멈춰도 6초에 실패하며 종료 명령을 정리한다', async () => {
  const h = harness('win32')
  await h.sidecar.configure('/project', 'base')
  h.children[0].shutdown = false
  const stopped = h.sidecar.stop()
  const failure = expect(stopped).rejects.toMatchObject({ code: 'sidecar_stop_timeout' })
  await h.advance(6000); await failure
  expect(h.killers[0].kills).toEqual(['SIGKILL'])
  h.children[0].close()
  await expect(h.sidecar.configure('/project', 'venv')).rejects.toMatchObject({ data: { recovery: 'external_cleanup' } })
  expect(h.children).toHaveLength(1)
})

for (const phase of ['ready', 'methods.list'] as const) {
  test(`F-IMPL-01 ${phase} 무응답도 시작 전체 10초에 실패하고 소유 프로세스를 정리한다`, async () => {
    const h = harness(); h.manualReady()
    const configured = h.sidecar.configure('/project', 'base')
    const failure = expect(configured).rejects.toMatchObject({ code: 'sidecar_start_timeout' })
    await flush()
    const child = h.children[0]
    if (phase === 'methods.list') { child.introspect = false; child.ready() }
    await h.advance(9999)
    expect(child.requests.some(r => r.method === 'shutdown')).toBe(false)
    await h.advance(1); await failure
    expect(child.requests.some(r => r.method === 'shutdown')).toBe(true)
    expect(child.exitCode).toBe(0)
    expect(h.sidecar.status().running).toBe(false)
    await h.sidecar.stop()
  })

  test(`F-IMPL-01 ${phase} 대기 중 stop은 즉시 shutdown하고 선행 시작들을 취소한다`, async () => {
    const h = harness(); h.manualReady()
    const configured = h.sidecar.configure('/project', 'base')
    const cancelled = expect(configured).rejects.toMatchObject({ code: 'sidecar_start_cancelled' })
    await flush()
    const child = h.children[0]
    if (phase === 'methods.list') { child.introspect = false; child.ready(); await flush() }
    child.shutdown = false
    const queued = h.sidecar.configure('/other', 'venv')
    const queuedCancelled = expect(queued).rejects.toMatchObject({ code: 'sidecar_start_cancelled' })
    const restarted = h.sidecar.restart()
    const restartCancelled = expect(restarted).rejects.toMatchObject({ code: 'sidecar_start_cancelled' })
    const stopped = h.sidecar.stop()
    expect(child.requests.some(r => r.method === 'shutdown')).toBe(true)
    await h.advance(3000)
    await stopped; await cancelled; await queuedCancelled; await restartCancelled
    expect(child.kills).toEqual(['SIGKILL'])
    expect(child.exitCode).toBe(0)
    expect(h.children).toHaveLength(1)
    expect(h.sidecar.status().running).toBe(false)
  })
}

test('F-IMPL-01 시작 중 stop 실패는 6초에 격리하고 자동 재종료로 상한을 늘리지 않는다', async () => {
  const h = harness(); h.manualReady()
  const configured = h.sidecar.configure('/project', 'base')
  const cancelled = expect(configured).rejects.toMatchObject({ code: 'sidecar_start_cancelled' })
  await flush()
  const child = h.children[0]; child.shutdown = false; child.killMode = 'ignore'
  const stopped = h.sidecar.stop()
  const failed = expect(stopped).rejects.toMatchObject({ code: 'sidecar_stop_timeout', data: { recovery: 'retry_stop' } })
  await h.advance(6000); await failed; await cancelled
  expect(child.kills).toEqual(['SIGKILL'])
  expect(child.requests.filter(r => r.method === 'shutdown')).toHaveLength(1)
  await expect(h.sidecar.configure('/other', 'venv')).rejects.toMatchObject({ code: 'sidecar_stop_timeout' })
  expect(h.children).toHaveLength(1)
  child.close()
})

test('skill switch drains read RPCs, rejects every new call, and restarts with a new scripts directory', async () => {
  const h = harness()
  await h.sidecar.configure(null, 'base')
  const running = h.sidecar.call<{ value: string }>('hold')
  await flush()
  let switched = false
  const switching = skillSwitch.switch(async () => {
    h.setScripts('/scripts/S1')
    await h.sidecar.restart()
    switched = true
  })
  await expect(Promise.resolve(h.sidecar.call('project.status'))).rejects.toMatchObject({ message: expect.stringContaining('규칙집') })
  expect(switched).toBe(false)
  const old = h.children[0], held = old.requests.find(r => r.method === 'hold')!
  old.line({ id: held.id, result: { value: 'S0' } })
  expect(await running).toEqual({ value: 'S0' })
  await switching
  expect(old.exitCode).toBe(0)
  expect(h.sidecar.status().scriptsDir).toBe('/scripts/S1')
  expect(h.spawnArgs[1]).toContain('/scripts/S1')
  h.setScripts('/scripts/S0')
  await h.sidecar.configure(null, 'base')
  expect(h.children[1].exitCode).toBe(0)
  expect(h.spawnArgs[2]).toContain('/scripts/S0')
  await h.sidecar.stop()
})
