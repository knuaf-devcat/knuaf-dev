import { expect, test } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { connectStoreBroker, StoreBrokerError, type OpenStore, type StoreBackend, type StoreDiagnostic } from '../src/main/update/appStore'
import { AppUpdates, type AppUpdateStatus } from '../src/main/update/appService'
import { updateConfig } from '../src/main/update/keys'
import { ASSET_PREFIX, CHANNEL_URL, sha256 } from '../src/main/update/manifest'
import { releasePage } from '../src/main/update/appManifest'
import type * as Ipc from '../src/main/ipc'

class Child extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  closed = false
  shutdownCode = 0
  bootstrapped = false
  beforeKill = () => {}
  onShutdown = () => {}
  onCommand: (command: Record<string, unknown>) => void = () => {}
  stdin = new Writable({ write: (bytes, _encoding, callback) => {
    if (!this.bootstrapped) this.bootstrapped = true
    else this.onCommand(JSON.parse(String(bytes)))
    callback()
  } })
  constructor() { super(); this.stdin.on('finish', () => { this.onShutdown(); this.close(this.shutdownCode) }) }
  line(value: object) { this.stdout.write(JSON.stringify(value) + '\n') }
  close(code = 0) {
    if (this.closed) return
    this.closed = true; this.exitCode = code
    this.stdout.end(); this.stderr.end(); this.emit('close', code, null)
  }
  kill() { this.beforeKill(); this.close(137); return true }
}
const connect = (child: Child, ready = 1000): Promise<StoreBackend> => connectStoreBroker(child as unknown as ChildProcessWithoutNullStreams, 'test-only native body', { ready, close: 1000 })
const details = (error: StoreBrokerError): string => JSON.stringify({ ...error, message: error.message, stack: error.stack })
const privatePath = String.raw`C:\Users\Student Name\Thesis Folder\draft.docx`

test('pre-ready process exit preserves compiler reason and exit status without exposing a student path', async () => {
  const child = new Child(), opening = connect(child)
  child.stderr.write(String.raw`C:\Users\Student Name\Temp\build.cs(12,34): error CS0246: RequiredType could not be found`)
  child.close(1)
  const error = await opening.catch(error => error) as StoreBrokerError
  expect(error).toBeInstanceOf(StoreBrokerError)
  expect(error.diagnostic).toMatchObject({ reason: 'exit', stage: 'initialize', exitCode: 1 })
  expect(error.diagnostic.compilerCodes).toEqual(['CS0246'])
  for (const value of ['Student Name', 'C:', 'RequiredType']) expect(details(error)).not.toContain(value)
})

test('native initialization retains only Win32/HRESULT and compiler codes including late stderr', async () => {
  const child = new Child(), opening = connect(child)
  child.beforeKill = () => { child.stderr.write('<S S="Error">error CS1501: wrong overload_x000D__x000A_</S>') }
  const credential = 'synthetic-only-sensitive-value'
  const message = `Access denied to '${privatePath}'. password=${credential}\n-----BEGIN PRIVATE KEY-----\nsynthetic-not-a-real-key\n-----END PRIVATE KEY-----`
  child.line({ ok: false, diagnostic: { type: 'System.ComponentModel.Win32Exception', nativeCode: 5, hresult: -2147024891, message } })
  const error = await opening.catch(error => error) as StoreBrokerError
  expect(error.diagnostic).toEqual({ reason: 'native', stage: 'initialize', nativeType: 'System.ComponentModel.Win32Exception', nativeCode: 5, hresult: '0x80070005', compilerCodes: ['CS1501'] })
  for (const value of [privatePath, 'Student Name', credential, 'synthetic-not-a-real-key', 'BEGIN PRIVATE KEY', 'Access denied', 'wrong overload']) expect(details(error)).not.toContain(value)
})

test('an exit with a pending operation keeps the operation and blocks subsequent IO', async () => {
  const child = new Child(), opening = connect(child); child.line({ ok: true })
  const backend = await opening
  const reading = backend.request({ op: 'read', path: 'pending.json' })
  child.stderr.write('native read failed'); child.close(7)
  await expect(reading).rejects.toMatchObject({ code: 'update_store_exit', diagnostic: { stage: 'read', exitCode: 7 } })
  await expect(backend.request({ op: 'remove', path: 'pending.json' })).rejects.toMatchObject({ code: 'update_store_exit' })
  await expect(backend.close()).rejects.toMatchObject({ diagnostic: { stage: 'read', exitCode: 7 } })
})

test('a native operation rejection survives cleanup without losing the original sharing error', async () => {
  const child = new Child(), opening = connect(child); child.line({ ok: true })
  const backend = await opening, verifying = backend.request({ op: 'verify', path: '0.6.0/installer.exe', size: 1, sha256: 'a'.repeat(64) })
  child.line({ ok: false, diagnostic: { type: 'System.ComponentModel.Win32Exception', nativeCode: 32, hresult: -2147024864, message: `Sharing denied for '${privatePath}'` } })
  await expect(verifying).rejects.toMatchObject({ diagnostic: { reason: 'native', stage: 'verify', nativeCode: 32, hresult: '0x80070020' } })
  await expect(backend.close()).rejects.toMatchObject({ diagnostic: { reason: 'native', stage: 'verify', nativeCode: 32 } })
})

for (const stream of ['spawn', 'stdin'] as const) test(`${stream} OS failure preserves its safe code without retaining raw cause`, async () => {
  const child = new Child(), opening = connect(child)
  const error = Object.assign(new Error(`Access to '${privatePath}' failed`), { code: stream === 'spawn' ? 'ENOENT' : 'EPIPE', errno: stream === 'spawn' ? -2 : -32 })
  if (stream === 'spawn') child.emit('error', error); else child.stdin.emit('error', error)
  const failure = await opening.catch(error => error) as StoreBrokerError
  expect(failure.diagnostic).toMatchObject({ reason: stream, osCode: error.code, errno: error.errno, stage: 'initialize' })
  expect(details(failure)).not.toContain('Student Name'); expect('cause' in failure).toBe(false)
})

test('malformed stdout fails closed and never echoes record contents into diagnostics', async () => {
  const child = new Child(), opening = connect(child)
  child.stdout.write(`malformed record '${privatePath}' sensitive-record-content\n`)
  const error = await opening.catch(error => error) as StoreBrokerError
  expect(error.code).toBe('update_store_protocol')
  expect(details(error)).not.toContain('sensitive-record-content'); expect(details(error)).not.toContain('Student Name')
})

test('missing readiness keeps the initialization timeout distinct from a native policy failure', async () => {
  const child = new Child()
  await expect(connect(child, 1)).rejects.toMatchObject({ code: 'update_store_timeout', diagnostic: { stage: 'initialize', reason: 'timeout' } })
})

const pair = generateKeyPairSync('ed25519'), publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const config = updateConfig(false, { KNUAF_UPDATE_PUBLIC_KEY: publicKey })
function appOptions(root: string) {
  const bytes = Buffer.from('inert test installer'), manifest = { schema: 1, name: 'knuaf-dev-app', version: '0.6.0', platform: 'win32-x64', url: ASSET_PREFIX + 'v0.6.0/setup.exe', size: bytes.length, sha256: sha256(bytes) }
  const original = Buffer.from(JSON.stringify(manifest)), envelope = { manifest: original.toString('base64'), sig: sign(null, original, pair.privateKey).toString('base64') }
  return { userData: root, current: '0.5.1', platform: 'win32' as NodeJS.Platform, arch: 'x64', config, handoff: { run: async (action: () => Promise<void>) => action() },
    fetch: async (url: string) => new Response(url === CHANNEL_URL ? JSON.stringify({ schema: 1, app: { latest: '0.6.0', page: releasePage('0.6.0'), 'win32-x64': envelope } }) : bytes),
    startInstaller: async () => {}, quit: () => {}, openExternal: async () => {} }
}

for (const exit of [0, 9]) test(`startup recovery distinguishes clean EOF from a failed broker cleanup, exit=${exit}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'knuaf-store-diagnostic-'))
  try {
    const app = new AppUpdates({ ...appOptions(root), openStore: async () => {
      const child = new Child(); child.shutdownCode = exit
      child.onCommand = () => child.line({ ok: true, result: null })
      const opening = connect(child); child.line({ ok: true }); return opening
    } })
    await app.ready
    expect(app.status().phase).toBe(exit === 0 ? 'idle' : 'error')
    if (exit !== 0) { expect(app.status().message).toContain('stage=close'); expect(app.status().message).toContain('exit=9') }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a real signed update exposes the sanitized broker failure while preserving student bytes and never handing off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knuaf-store-app-')), student = join(root, 'thesis.txt'); writeFileSync(student, 'keep student bytes')
  let installs = 0, quits = 0
  try {
    const app = new AppUpdates({ ...appOptions(root), startInstaller: async () => { ++installs }, quit: () => { ++quits }, openStore: async () => {
      const child = new Child(), opening = connect(child)
      child.stderr.write(`Native bootstrap failed for '${root}' with CS0246`); child.close(1)
      return opening
    } })
    await app.check()
    await expect(app.install()).rejects.toMatchObject({ code: 'update_store_exit', diagnostic: { stage: 'initialize', exitCode: 1 } })
    expect(app.status().phase).toBe('error'); expect(app.status().message).toContain('CS0246'); expect(app.status().message).not.toContain(root)
    expect(installs).toBe(0); expect(quits).toBe(0); expect(readFileSync(student, 'utf8')).toBe('keep student bytes')
    expect(existsSync(join(root, 'app-update', 'pending.json'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('shutdown native error is not replaced by a protocol error or a later exit', async () => {
  const child = new Child(), opening = connect(child); child.line({ ok: true })
  const backend = await opening
  child.onShutdown = () => child.line({ ok: false, diagnostic: { type: 'System.UnauthorizedAccessException', nativeCode: 5, hresult: -2147024891, message: `Cleanup denied for '${privatePath}'` } })
  child.shutdownCode = 1
  await expect(backend.close()).rejects.toMatchObject({ code: 'update_store_native', diagnostic: { stage: 'close', nativeType: 'System.UnauthorizedAccessException', nativeCode: 5 } })
})

const privacyInputs = [
  ['relative', String.raw`Access denied to '..\StudentMarker\thesis.docx'`],
  ['drive-relative short name', String.raw`Access denied to 'C:STUDEN~1\THESIS~1.DOC'`],
  ['percent encoded', 'Access denied to C%3A%5CUsers%5CStudentMarker%5Cthesis.docx'],
  ['apostrophe', String.raw`Access denied to 'C:\Users\O'StudentMarker\thesis.docx'`],
  ['JSON token', '{"access_token":"syntheticCredentialMarker1234567890"}'],
  ['free username', 'User StudentMarker is not authorized'],
  ['relative forward slashes', 'Open ./StudentMarker/research/thesis.docx'],
  ['drive-relative long name', String.raw`Open c:StudentMarker\research\thesis.docx`],
  ['double percent encoded', 'Open C%253A%255CUsers%255CStudentMarker%255Cthesis.docx'],
  ['apostrophe variation', String.raw`Open C:\Users\StudentMarker's Research\thesis.docx`],
  ['nested quoted token', '{"credentials":{"ACCESS_TOKEN" : "syntheticCredentialMarker1234567890"}}'],
  ['Unicode free username', '사용자 StudentMarker_합성 의 접근이 거절됐습니다']
] as const
const forbidden = ['StudentMarker', 'STUDEN~1', 'THESIS~1', 'syntheticCredentialMarker1234567890', 'PrivateFreeTextMarker']

// Compile the actual IPC module in a private CommonJS wrapper. Electron's transport
// and the unrelated skill-source callback are substitutes; AppUpdates, its broker,
// and the registered app-update handlers are real. No global module cache mutation.
type IpcModule = typeof Ipc
const ipcFile = join(__dirname, '../src/main/ipc.ts'), ipcRequire = createRequire(ipcFile)
const ipcFactory = new Script(`(function(require, exports) {\n${transpileModule(readFileSync(ipcFile, 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText}\n})`, { filename: ipcFile }).runInThisContext() as (require: (name: string) => unknown, exports: Partial<IpcModule>) => void

function ipcHarness(root: string, openStore: OpenStore, counts: { installs: number; quits: number }) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>(), events: AppUpdateStatus[] = []
  let updates!: AppUpdates
  const dependencies: Record<string, unknown> = {
    electron: {
      app: { isPackaged: false, getPath: () => root, getVersion: () => '0.5.1', quit: () => { ++counts.quits } },
      ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) },
      net: { fetch: () => { throw new Error('Unexpected unrelated skill network request') } }
    },
    './update/keys': { updateConfig: () => ({ ...config, keys: [] }) },
    './update/source': { configureSkillSource: () => {} },
    './update/appService': { AppUpdates: class extends AppUpdates {
      constructor(options: ConstructorParameters<typeof AppUpdates>[0]) {
        super({ ...appOptions(root), emit: options.emit, openStore, startInstaller: async () => { ++counts.installs }, quit: () => { ++counts.quits } })
        updates = this
      }
    } }
  }
  const module: Partial<IpcModule> = {}
  ipcFactory(name => Object.hasOwn(dependencies, name) ? dependencies[name] : ipcRequire(name), module)
  const win = { webContents: { send: (channel: string, status: AppUpdateStatus) => { if (channel === 'app-update:status') events.push(structuredClone(status)) } } }
  module.registerIpc!(new EventEmitter() as unknown as Parameters<IpcModule['registerIpc']>[0], () => win as unknown as ReturnType<Parameters<IpcModule['registerIpc']>[1]>)
  return { updates, events, invoke: async (name: string) => {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`Missing IPC handler: ${name}`)
    return handler()
  } }
}

for (const [label, payload] of privacyInputs) for (const source of ['native', 'stderr'] as const) test(`R1 privacy: ${label} via ${source} cannot reach errors, events or registered IPC`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'knuaf-store-privacy-')), student = join(root, 'thesis.txt')
  writeFileSync(student, 'keep student bytes')
  const failures: StoreBrokerError[] = [], counts = { installs: 0, quits: 0 }
  const openStore: OpenStore = async () => {
    const child = new Child(), opening = connect(child)
    const message = `${payload}\nPrivateFreeTextMarker: error CS9999; PS1234`
    if (source === 'native') child.line({ ok: false, diagnostic: { type: 'System.UnauthorizedAccessException', nativeCode: 5, hresult: -2147024891, message, errorId: 'SOURCE_CODE_ERROR,StudentMarker', path: payload, stderr: payload } })
    else { child.stderr.write(`${message}; FullyQualifiedErrorId: SOURCE_CODE_ERROR`); child.close(23) }
    return opening.catch(error => { failures.push(error); throw error })
  }
  try {
    const h = ipcHarness(root, openStore, counts)
    await h.updates.ready
    // registerIpc starts an automatic check, so observe recovery's event rather
    // than racing the live state, which may already be checking.
    expect(h.events.find(event => event.phase === 'error')).toMatchObject({ phase: 'error' })
    expect(await h.invoke('app-update:check')).toMatchObject({ result: { phase: 'available' } })
    const beforeInstall = h.events.length
    const response = await h.invoke('app-update:install')
    expect(response).toMatchObject({ error: { code: 'update' } })
    expect(await h.invoke('app-update:status')).toMatchObject({ result: { phase: 'error' } })
    const expected = source === 'native'
      ? { reason: 'native', stage: 'initialize', nativeType: 'System.UnauthorizedAccessException', nativeCode: 5, hresult: '0x80070005', compilerCodes: ['CS9999', 'PS1234', 'SOURCE_CODE_ERROR'] }
      : { reason: 'exit', stage: 'initialize', exitCode: 23, compilerCodes: ['CS9999', 'PS1234', 'SOURCE_CODE_ERROR'] }
    for (const error of failures) { expect(error).toBeInstanceOf(StoreBrokerError); expect(error.diagnostic).toEqual(expected) }
    expect(h.events.slice(beforeInstall).filter(event => event.phase === 'error')).toEqual([h.updates.status()])
    const surfaces = [details(failures[0]), details(failures[1]), JSON.stringify(h.updates.status()), JSON.stringify(h.events), JSON.stringify(response), JSON.stringify(await h.invoke('app-update:status'))]
    for (const surface of surfaces) {
      for (const marker of forbidden) expect(surface).not.toContain(marker)
      for (const code of ['CS9999', 'PS1234', 'SOURCE_CODE_ERROR', 'stage=initialize']) expect(surface).toContain(code)
      expect(surface).toContain(source === 'native' ? '0x80070005' : 'exit=23')
    }
    expect(counts).toEqual({ installs: 0, quits: 0 })
    expect(readFileSync(student, 'utf8')).toBe('keep student bytes')
    expect(existsSync(join(root, 'app-update', 'pending.json'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('diagnostic allowlist rejects arbitrary fields and identifier-shaped private values', () => {
  const error = new StoreBrokerError({
    reason: 'native', stage: 'StudentMarker', osCode: 'ESTUDENTMARKER', signal: 'SIGSTUDENTMARKER',
    nativeType: 'StudentMarker.Exception', hresult: '0xStudentMarker', nativeCode: Number.NaN,
    compilerCodes: ['CS9999', 'CS9999StudentMarker', 'StudentMarker', 'PS1234'],
    message: 'StudentMarker', stderr: 'StudentMarker', path: 'StudentMarker'
  } as StoreDiagnostic)
  expect(error.diagnostic).toEqual({ reason: 'native', stage: 'unknown', nativeType: 'other', compilerCodes: ['CS9999', 'PS1234'] })
  expect(details(error)).not.toContain('StudentMarker'); expect(details(error)).not.toContain('STUDENTMARKER')
  expect('cause' in error).toBe(false)
  expect(error.stack).not.toContain(__filename)
})

test('OS identifier coercion cannot smuggle object properties into public diagnostics', () => {
  const error = new StoreBrokerError({
    reason: 'spawn', stage: 'initialize',
    osCode: { toString: () => 'ENOENT', privateData: 'StudentMarker' },
    signal: { toString: () => 'SIGTERM', privateData: 'syntheticCredentialMarker1234567890' }
  } as unknown as StoreDiagnostic)
  expect(error.diagnostic).toEqual({ reason: 'spawn', stage: 'initialize' })
  for (const marker of forbidden) expect(details(error)).not.toContain(marker)
})

for (const [label, nativeType, category] of [
  ['unknown identifier', 'System.StudentMarkerException', 'other'],
  ['unknown credential namespace', 'System.syntheticCredentialMarker1234567890.Exception', 'other'],
  ['known filesystem exception', 'System.IO.IOException', 'System.IO.IOException'],
  ['known load exception', 'System.TypeLoadException', 'System.TypeLoadException']
] as const) test(`FIX2 fixed exception category: ${label} across all six public surfaces`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'knuaf-type-privacy-')), student = join(root, 'thesis.txt')
  writeFileSync(student, 'keep student bytes')
  const failures: StoreBrokerError[] = [], counts = { installs: 0, quits: 0 }
  const openStore: OpenStore = async () => {
    const child = new Child(), opening = connect(child)
    child.line({ ok: false, diagnostic: { type: nativeType, nativeCode: 5, hresult: -2147024891, message: 'error CS9999; PS1234', errorId: 'SOURCE_CODE_ERROR' } })
    return opening.catch(error => { failures.push(error); throw error })
  }
  try {
    const h = ipcHarness(root, openStore, counts)
    await h.updates.ready
    expect(await h.invoke('app-update:check')).toMatchObject({ result: { phase: 'available' } })
    const response = await h.invoke('app-update:install'), status = await h.invoke('app-update:status')
    expect(response).toMatchObject({ error: { code: 'update' } })
    expect(status).toMatchObject({ result: { phase: 'error' } })
    for (const error of failures) {
      expect(error).toBeInstanceOf(StoreBrokerError)
      expect(error.diagnostic).toEqual({ reason: 'native', stage: 'initialize', nativeType: category, nativeCode: 5, hresult: '0x80070005', compilerCodes: ['CS9999', 'PS1234', 'SOURCE_CODE_ERROR'] })
    }
    const surfaces = {
      recovery: details(failures[0]), install: details(failures[1]), state: JSON.stringify(h.updates.status()),
      events: JSON.stringify(h.events), installIPC: JSON.stringify(response), statusIPC: JSON.stringify(status)
    }
    for (const [surfaceName, surface] of Object.entries(surfaces)) {
      expect(surface, surfaceName).toContain(`native=${category}`)
      for (const marker of forbidden) expect(surface, surfaceName).not.toContain(marker)
      for (const code of ['stage=initialize', 'CS9999', 'PS1234', 'SOURCE_CODE_ERROR', '0x80070005']) expect(surface, surfaceName).toContain(code)
    }
    expect(counts).toEqual({ installs: 0, quits: 0 })
    expect(readFileSync(student, 'utf8')).toBe('keep student bytes')
    expect(existsSync(join(root, 'app-update', 'pending.json'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('canonical diagnostic codes preserve leading zeroes and exclude trailing text or confusable digits', () => {
  const error = new StoreBrokerError({
    reason: 'exit', stage: 'read', exitCode: 23, signal: 'SIGTERM', osCode: 'ENOENT', errno: -2,
    nativeCode: 5, hresult: '0x00000005',
    compilerCodes: ['CS0001', 'PS0000', 'SOURCE_CODE_ERROR', 'CS9999StudentMarker', 'PS1234\n', 'CS１２３４']
  })
  expect(error.diagnostic).toEqual({
    reason: 'exit', stage: 'read', exitCode: 23, signal: 'SIGTERM', osCode: 'ENOENT', errno: -2,
    nativeCode: 5, hresult: '0x00000005', compilerCodes: ['CS0001', 'PS0000', 'SOURCE_CODE_ERROR']
  })
  for (const marker of forbidden) expect(details(error)).not.toContain(marker)
})
