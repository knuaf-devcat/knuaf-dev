import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { AppUpdates } from '../src/main/update/appService'
import * as store from '../src/main/update/appStore'
import * as manifest from '../src/main/update/manifest'
import * as appManifest from '../src/main/update/appManifest'
import * as network from '../src/main/update/network'
import * as download from '../src/main/runtimeDownload'
import { WindowsUpdateRuntime, type PowerShell } from '../src/main/update/windows'
import type { InstallerLaunch } from '../src/main/update/nativeInstaller'
import { AppHandoff } from '../src/main/update/handoff'
import { agentActivity } from '../src/main/update/activity'
import { SkillSwitch } from '../src/main/update/switch'
import { OwnedProcessWatch, type ProcessInfo } from '../src/main/update/processes'
import { updateConfig } from '../src/main/update/keys'

// FIX1 forbids key generation. Only signature verification's RETURN is substituted;
// the real store, SHA-256, adapter, download pipeline and AppUpdates ordering execute.
const source = transpileModule(readFileSync(join(__dirname, '../src/main/update/appService.ts'), 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
const roots: string[] = []
const temporary = (): string => { const root = mkdtempSync(join(tmpdir(), 'knuaf-update-security-')); roots.push(root); return root }
test.afterEach(() => { agentActivity.resume(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const approved = Buffer.from('approved harmless installer bytes')
// Playwright's async matcher cannot consume a foreign-realm Promise directly.
const install = (updates: AppUpdates): Promise<void> => Promise.resolve(updates.install())
const changed = Buffer.from(approved); changed[0] ^= 1
function scenario() {
  const root = temporary(), v = '0.6.0', path = join(root, 'app-update', v, 'installer.exe')
  const m = { schema: 1 as const, name: 'knuaf-dev-app' as const, version: v, platform: 'win32-x64' as const, url: `${manifest.ASSET_PREFIX}v${v}/setup.exe`, size: approved.length, sha256: digest(approved) }
  const envelope = { manifest: Buffer.from(JSON.stringify(m)).toString('base64'), sig: 'TEST-ONLY-signature-return-substitution' }
  const proof = { manifest: m, envelope }, exported = { exports: {} as { AppUpdates: typeof AppUpdates } }
  runInNewContext(source, { module: exported, exports: exported.exports, Promise, Buffer, Error, AbortController, AbortSignal,
    require: (name: string) => {
      if (name === './appManifest') return { ...appManifest, parseApp: () => proof, verifyApp: (_value: unknown, _keys: string[], current: string) => { if (manifest.compare(v, current) <= 0) throw new Error('newer only'); return proof } }
      if (name === './appStore') return store
      if (name === './manifest') return manifest
      if (name === './network') return network
      if (name === '../runtimeDownload') return download
      if (name === 'node:path') return require(name)
      throw new Error(`unexpected dependency ${name}`)
    }
  })
  let quit = 0, assets = 0, response: string | null = null, onLaunching = () => {}, beforePin = () => {}, afterHash = () => {}, uac = () => {}
  let held = false
  const executed: Buffer[] = [], denied: string[] = []
  // Native boundary MODEL, not evidence of Windows APIs executing. Attempts before
  // acquisition really mutate the test FS; while held the Windows sharing contract
  // denies them. The disk bytes are hashed through the opened descriptor.
  const edit = (kind: string): void => {
    if (held) { denied.push(kind); throw new Error('ERROR_SHARING_VIOLATION') }
    if (kind === 'write') writeFileSync(path, changed)
    if (kind === 'file') { renameSync(path, path + '.old'); writeFileSync(path, changed) }
    if (kind === 'parent') { renameSync(join(root, 'app-update', v), join(root, 'app-update', v + '-old')); mkdirSync(join(root, 'app-update', v)); writeFileSync(path, changed) }
  }
  const shell: PowerShell = async (_script, _timeout, request) => {
    if (!request) throw new Error('launch request missing')
    beforePin()
    let fd: number | null = null
    try {
      for (const dir of [root, join(root, 'app-update'), join(root, 'app-update', v)]) if (lstatSync(dir).isSymbolicLink()) throw new Error('reparse point')
      if (realpathSync(path) !== join(realpathSync(root), 'app-update', v, 'installer.exe')) throw new Error('identity mismatch')
      fd = openSync(request.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      held = true
      const st = fstatSync(fd), bytes = readFileSync(fd)
      if (st.nlink !== 1 || st.size !== request.size || digest(bytes) !== request.sha256) return JSON.stringify({ started: false, cancelled: false })
      afterHash(); uac()
      executed.push(bytes)
      return response ?? JSON.stringify({ started: true, pid: 42 })
    } catch { return JSON.stringify({ started: false, cancelled: false }) }
    finally { held = false; if (fd !== null) closeSync(fd) }
  }
  const runtime = new WindowsUpdateRuntime('C:/App/resources', 'C:/App/app.exe', 1, shell)
  const options = {
    userData: root, current: '0.5.1', platform: 'win32' as NodeJS.Platform, arch: 'x64', config: { ...updateConfig(false, {}), keys: ['TEST-ONLY-proof-return-substitution'] },
    handoff: { run: async (action: () => Promise<void>) => action() },
    fetch: async (url: string) => { if (url === manifest.CHANNEL_URL) return new Response(JSON.stringify({ schema: 1, app: { latest: v, page: appManifest.releasePage(v), 'win32-x64': envelope } })); ++assets; return new Response(approved) },
    startInstaller: (request: InstallerLaunch) => runtime.startInstaller(request), quit: () => { ++quit }, openExternal: async () => {},
    emit: (status: { phase: string }) => { if (status.phase === 'launching') onLaunching() }
  }
  const updates = new exported.exports.AppUpdates(options)
  return { root, path, options, updates, Constructor: exported.exports.AppUpdates, executed, denied, edit,
    quit: () => quit, assets: () => assets, reply: (text: string) => { response = text },
    launching: (fn: () => void) => { onLaunching = fn }, preparation: (fn: () => void) => { beforePin = fn }, locked: (fn: () => void) => { afterHash = fn }, elevation: (fn: () => void) => { uac = fn }
  }
}

test('normal install, durable interrupted recovery, verified cache reuse and bounded cleanup preserve unknown student files', async () => {
  const h = scenario(); await h.updates.check(); await h.updates.install()
  expect(h.executed).toEqual([approved]); expect(h.quit()).toBe(1)
  const resumed = new h.Constructor(h.options); await resumed.ready
  expect(resumed.status().phase).toBe('interrupted'); await resumed.install(); expect(h.assets()).toBe(1)
  const student = join(h.root, 'app-update', '0.6.0', 'thesis.txt'); writeFileSync(student, 'keep thesis')
  const next = new h.Constructor({ ...h.options, current: '0.6.0' }); await next.ready
  expect(next.status().message).toContain('마쳤'); expect(existsSync(h.path)).toBe(false)
  expect(existsSync(join(h.root, 'app-update', 'pending.json'))).toBe(false); expect(readFileSync(student, 'utf8')).toBe('keep thesis')
})

for (const phase of ['launching', 'preparation'] as const) for (const kind of ['write', 'file', 'parent']) test(`R1-01: ${phase} ${kind} replacement cannot execute changed bytes or quit`, async () => {
  const h = scenario(); h[phase](() => h.edit(kind))
  await h.updates.check(); await expect(install(h.updates)).rejects.toThrow()
  expect(h.executed).toEqual([]); expect(h.quit()).toBe(0)
})
for (const phase of ['locked', 'elevation'] as const) test(`R1-01: ${phase} model holds file and all parent pins through the start result`, async () => {
  const h = scenario()
  h[phase](() => { for (const kind of ['write', 'file', 'parent']) expect(() => h.edit(kind)).toThrow(/SHARING_VIOLATION/) })
  await h.updates.check(); await h.updates.install()
  expect(h.denied).toEqual(['write', 'file', 'parent']); expect(h.executed).toEqual([approved])
})

for (const member of ['installer.exe.download', 'manifest.json.tmp', 'installer.exe', 'manifest.json', '../pending.json.tmp', '../pending.json']) for (const link of ['hard', 'symbolic']) test(`R1-02: initial install rejects ${link} ${member} without changing outside bytes`, async () => {
  const h = scenario(); await h.updates.ready
  mkdirSync(join(h.root, 'app-update', '0.6.0'), { recursive: true })
  const student = join(h.root, 'thesis.txt'), bytes = Buffer.from('student data must remain byte-identical'); writeFileSync(student, bytes)
  const target = join(h.root, 'app-update', '0.6.0', member)
  if (link === 'hard') linkSync(student, target); else symlinkSync(student, target)
  await h.updates.check(); await expect(install(h.updates)).rejects.toThrow()
  expect(readFileSync(student)).toEqual(bytes); expect(h.executed).toEqual([]); expect(h.quit()).toBe(0)
})
for (const boundary of ['root', 'version']) test(`R1-02: initial install refuses linked ${boundary} before writing outside the store`, async () => {
  const h = scenario(); await h.updates.ready
  const outside = join(h.root, 'student-folder'); mkdirSync(join(outside, '0.6.0'), { recursive: true })
  const student = join(outside, '0.6.0', 'thesis.txt'); writeFileSync(student, approved)
  const root = join(h.root, 'app-update')
  if (boundary === 'root') symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
  else { mkdirSync(root); symlinkSync(join(outside, '0.6.0'), join(root, '0.6.0'), process.platform === 'win32' ? 'junction' : 'dir') }
  await h.updates.check(); await expect(install(h.updates)).rejects.toThrow()
  expect(readFileSync(student)).toEqual(approved); expect(h.executed).toEqual([]); expect(h.quit()).toBe(0)
})
for (const boundary of ['root', 'version']) for (const emptyKeys of [false, true]) test(`R1-02: startup cleanup refuses linked ${boundary}, emptyKeys=${emptyKeys}`, async () => {
  const h = scenario(); await h.updates.ready
  const outside = join(h.root, 'student-folder'); mkdirSync(join(outside, '0.6.0'), { recursive: true })
  const student = join(outside, '0.6.0', 'thesis.txt'); writeFileSync(student, approved)
  const root = join(h.root, 'app-update')
  if (boundary === 'root') symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
  else { mkdirSync(root); symlinkSync(join(outside, '0.6.0'), join(root, '0.6.0'), process.platform === 'win32' ? 'junction' : 'dir') }
  writeFileSync(join(root, 'pending.json'), JSON.stringify({ from: '0.5.1', to: '0.6.0', installer: h.path, at: new Date().toISOString() }))
  const next = new h.Constructor({ ...h.options, current: '0.6.0', ...(emptyKeys ? { config: updateConfig(true, {}) } : {}) }); await next.ready
  expect(readFileSync(student)).toEqual(approved); expect(next.status().message).not.toContain('마쳤')
})
for (const member of ['installer.exe.download', 'manifest.json.tmp', 'installer.exe', 'manifest.json', '../pending.json.tmp', '../pending.json']) for (const link of ['hard', 'symbolic']) test(`R1-02: startup cleanup refuses ${link} ${member} and preserves outside bytes`, async () => {
  const h = scenario(); await h.updates.check(); await h.updates.install()
  const student = join(h.root, 'thesis.txt'); writeFileSync(student, 'keep outside')
  const target = join(h.root, 'app-update', '0.6.0', member); rmSync(target, { force: true })
  if (link === 'hard') linkSync(student, target); else symlinkSync(student, target)
  const next = new h.Constructor({ ...h.options, current: '0.6.0' }); await next.ready
  expect(readFileSync(student, 'utf8')).toBe('keep outside'); expect(next.status().message).not.toContain('마쳤')
})

test('R1-02: failed download releases its unique descriptor and a clean retry does not touch fixed temporary names', async () => {
  const h = scenario(), failed = new h.Constructor({ ...h.options, fetch: async url => url === manifest.CHANNEL_URL ? h.options.fetch(url) : new Response(changed) })
  await failed.check(); await expect(install(failed)).rejects.toMatchObject({ code: 'runtime_hash_mismatch' })
  expect(existsSync(h.path)).toBe(false); await h.updates.check(); await h.updates.install()
  expect(h.executed).toEqual([approved]); expect(existsSync(h.path + '.download')).toBe(false)
})

const p = (pid: number, parent: number, path: string | null, seconds = pid): ProcessInfo => ({ pid, parent, path, name: path?.replaceAll('\\', '/').split('/').at(-1) ?? 'unknown.exe', created: new Date(seconds * 1000).toISOString() })
for (const child of ['C:/App/resources/helper.exe', 'C:/Windows/System32/cmd.exe', 'C:/External/python.exe']) test(`R1-03: stop-time orphan ${child} blocks real handoff before installer`, async () => {
  const app = p(1, 0, 'C:/App/app.exe'), provider = p(2, 1, 'C:/App/resources/codex.exe')
  let rows = [app, provider], installed = false
  const root = temporary(), runtime = new WindowsUpdateRuntime(root, app.path!, 1, async () => JSON.stringify({ resources: 'C:/App/resources', appExecutable: app.path, processes: rows }))
  const handoff = new AppHandoff({ lock: new SkillSwitch(),
    sidecar: { stop: async () => { rows = [app, provider, p(3, 2, child)] }, restart: async () => {} },
    chat: { hasPendingLogin: () => false, flushDrafts: () => {}, closeForUpdate: async confirm => { rows = rows.filter(row => row.pid !== 2); await confirm() } },
    windows: { captureOwned: () => runtime.captureOwned(), confirmStopped: snapshot => runtime.confirmStopped(snapshot, 0), assertResourcesIdle: () => runtime.assertResourcesIdle() }
  })
  await expect(handoff.run(async () => { installed = true })).rejects.toThrow(/종료/)
  expect(installed).toBe(false); expect(agentActivity.suspended).toBe(false)
})
test('R1-03: unseen intermediate parent is unknown, while a proven unrelated reused PID does not inherit ownership', () => {
  const app = p(1, 0, 'C:/App/app.exe'), provider = p(2, 1, 'C:/App/resources/codex.exe'), outside = p(9, 0, 'C:/Other/parent.exe', 0)
  const watch = new OwnedProcessWatch({ processes: [app, provider, outside], appPid: 1, appExecutable: app.path! })
  expect(watch.busy([app, outside, p(4, 3, 'C:/External/python.exe')])).toBe(true)
  expect(watch.busy([app, outside, p(2, 9, 'C:/Other/unrelated.exe', 10)])).toBe(false)
  expect(watch.busy([app, outside])).toBe(false)
})

for (const response of ['', '   ', '{"started":', 'noise\n{"started":true,"pid":42}', '{}', '{"started":true}', '{"started":true,"pid":0}', '{"started":false}', '{"started":false,"cancelled":true,"pid":42}', '{"started":true,"pid":42,"cancelled":true}']) test(`R1-04: unknown native response ${JSON.stringify(response)} retains pending and never quits`, async () => {
  const h = scenario(); h.reply(response)
  await h.updates.check(); await expect(install(h.updates)).rejects.toMatchObject({ code: 'installer_unknown' })
  expect(h.quit()).toBe(0); expect(existsSync(join(h.root, 'app-update', 'pending.json'))).toBe(true)
  const next = new h.Constructor(h.options); await next.ready; expect(next.status().phase).toBe('interrupted')
})
test('R1-04: confirmed UAC cancellation removes pending, retains installer and allows verified cached retry', async () => {
  const h = scenario(); h.reply('{"started":false,"cancelled":true}')
  await h.updates.check(); await expect(install(h.updates)).rejects.toThrow(/취소/)
  expect(h.quit()).toBe(0); expect(existsSync(join(h.root, 'app-update', 'pending.json'))).toBe(false); expect(existsSync(h.path)).toBe(true)
  h.reply('{"started":true,"pid":99}'); await h.updates.install(); expect(h.quit()).toBe(1); expect(h.assets()).toBe(1)
})

test('R1-03: sub-millisecond parent PID reuse cannot hide an older owned orphan', () => {
  const app = p(1, 0, 'C:/App/app.exe'), outside = p(9, 0, 'C:/Other/parent.exe', 0)
  const provider = { ...p(2, 1, 'C:/App/resources/codex.exe'), created: '2026-10-30T10:00:00.0000001Z' }
  const reused = { ...p(2, 9, 'C:/Other/unrelated.exe'), created: '2026-10-30T10:00:00.0000009Z' }
  const orphan = { ...p(3, 2, 'C:/External/python.exe'), created: '2026-10-30T10:00:00.0000005Z' }
  const watch = new OwnedProcessWatch({ processes: [app, outside, provider], appPid: 1, appExecutable: app.path! })
  expect(watch.busy([app, outside, reused, orphan])).toBe(true)
})

test('real packaged empty-key policy stays closed after asynchronous store recovery and ignores developer overrides', async () => {
  const h = scenario(); let fetches = 0
  const actual = new AppUpdates({ ...h.options, config: updateConfig(true, { KNUAF_UPDATE_PUBLIC_KEY: 'TEST-ONLY-placeholder', KNUAF_UPDATE_CHANNEL_URL: 'http://127.0.0.1:1' }), fetch: async () => { ++fetches; throw new Error('must not fetch') } })
  expect((await actual.check()).phase).toBe('unavailable')
  await expect(actual.install()).rejects.toThrow()
  expect(fetches).toBe(0); expect(h.executed).toEqual([]); expect(h.quit()).toBe(0)
})
