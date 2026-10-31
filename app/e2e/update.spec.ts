import { expect, test } from '@playwright/test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { ASSET_PREFIX, CHANNEL_URL, compare, MAX_BYTES, sha256, verifySkill, type SkillManifest } from '../src/main/update/manifest'
import { extractSkill } from '../src/main/update/archive'
import { updateConfig } from '../src/main/update/keys'
import { boundedFetch } from '../src/main/update/network'
import { SkillStore } from '../src/main/update/store'
import { SkillSwitch, skillSwitch } from '../src/main/update/switch'
import { SkillUpdates } from '../src/main/update/service'
import { ChatService } from '../src/main/chat/service'
import { installSkill, skillVersion } from '../src/main/agent'

// Ephemeral test-only keys remain in this test process; no private key file is emitted.
const pair = generateKeyPairSync('ed25519')
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const keys = [publicKey]
const roots: string[] = []
function temporary(): string { const root = mkdtempSync(join(tmpdir(), 'knuaf-update-test-')); roots.push(root); return root }
test.afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
type Entry = { name: string; data: Buffer; mode?: number; method?: number; claimedSize?: number }
function zipEntries(entries: Entry[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name), data = e.method === 8 ? deflateRawSync(e.data) : e.data
    const local = Buffer.alloc(30), record = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(e.method ?? 0, 8)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(e.claimedSize ?? e.data.length, 22); local.writeUInt16LE(name.length, 26)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(e.method ?? 0, 10)
    record.writeUInt32LE(data.length, 20); record.writeUInt32LE(e.claimedSize ?? e.data.length, 24); record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(((e.mode ?? 0x81a4) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42)
    locals.push(local, name, data); central.push(record, name); offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
function envelope(m: object, whitespace = false) {
  const bytes = Buffer.from(JSON.stringify(m, null, whitespace ? 2 : undefined) + (whitespace ? '\n' : ''))
  return { manifest: bytes.toString('base64'), sig: sign(null, bytes, pair.privateKey).toString('base64') }
}
function fixture(v = '1.0.1', changes: Partial<SkillManifest> = {}, transform?: (entries: Entry[]) => Entry[]) {
  const entries: Entry[] = [
    { name: 'SKILL.md', data: Buffer.from(`# skill ${v}`), method: 8 },
    { name: 'skill.json', data: Buffer.from(JSON.stringify({ version: v, api: 1, source: { repo: 'starceas/knuaf-doc', tag: 'v0.2.0', commit: 'a'.repeat(40) }, overlay: 'b'.repeat(64) })) },
    { name: 'scripts/example.py', data: Buffer.from(`print('${v}')\n`) }
  ]
  const zip = zipEntries(transform ? transform(entries) : entries)
  const manifest: SkillManifest = { schema: 1, name: 'knuaf-dev', version: v, api: 1, minApp: '0.5.1', url: `${ASSET_PREFIX}skill-v${v}/knuaf-dev-skill-${v}.zip`, size: zip.length, sha256: sha256(zip), files: Object.fromEntries(entries.map(e => [e.name, sha256(e.data)])), ...changes }
  const signed = envelope(manifest)
  return { zip, manifest, signed, verified: () => verifySkill(signed, keys) }
}
function setup(bundleVersion = '1.0.0', useKeys = keys) {
  const root = temporary(), bundled = join(root, 'bundled')
  mkdirSync(join(bundled, 'scripts'), { recursive: true })
  writeFileSync(join(bundled, 'SKILL.md'), `# bundle ${bundleVersion}`)
  writeFileSync(join(bundled, 'scripts', 'example.py'), `print('${bundleVersion}')\n`)
  writeFileSync(join(bundled, 'skill.json'), JSON.stringify({ version: bundleVersion, api: 1 }))
  return { root, bundled, store: new SkillStore(root, bundled, '0.5.1', useKeys) }
}
const config = () => updateConfig(false, { KNUAF_UPDATE_PUBLIC_KEY: publicKey })
function updater(store: SkillStore, f = fixture(), restartSidecar: () => Promise<unknown> = async () => {}, lock = new SkillSwitch()) {
  const requests: string[] = []
  const updates = new SkillUpdates(store, { config: config(), lock, restartSidecar, fetch: async url => {
    requests.push(url)
    return new Response(url === CHANNEL_URL ? JSON.stringify({ schema: 1, skill: { ...f.signed, version: f.manifest.version, api: f.manifest.api, minApp: f.manifest.minApp, url: f.manifest.url } }) : f.zip)
  } })
  return { updates, requests }
}

test('Ed25519 verifies exact bytes, rejects altered bytes, signature, another key and unsigned hint mismatch', () => {
  const f = fixture()
  const formatted = envelope(f.manifest, true)
  expect(verifySkill(formatted, keys).manifest.version).toBe('1.0.1')
  expect(verifySkill(formatted, keys).digest).not.toBe(f.verified().digest)
  const changed = Buffer.from(formatted.manifest, 'base64'); changed[1] ^= 1
  expect(() => verifySkill({ ...formatted, manifest: changed.toString('base64') }, keys)).toThrow(/서명/)
  const bad = Buffer.from(f.signed.sig, 'base64'); bad[0] ^= 1
  expect(() => verifySkill({ ...f.signed, sig: bad.toString('base64') }, keys)).toThrow(/서명/)
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  expect(() => verifySkill(f.signed, [other])).toThrow(/서명/)
  expect(() => verifySkill({ ...f.signed, url: `${ASSET_PREFIX}other/file.zip` }, keys)).toThrow(/달라/)
  expect(() => verifySkill({ ...f.signed, manifest: f.signed.manifest + '\n' }, keys)).toThrow(/인코딩/)
})

for (const changes of [
  { version: '1.0.1-1' }, { version: '01.0.1' }, { version: '9007199254740992.0.1' }, { api: 0 }, { size: MAX_BYTES + 1 },
  { sha256: 'A'.repeat(64) }, { url: `${ASSET_PREFIX}../evil/file.zip` }, { url: 'https://evil.example/file.zip' },
  { files: { 'SKILL.md': 'a'.repeat(64), 'skill.json': 'b'.repeat(64), '../escape': 'c'.repeat(64) } },
  { files: { 'SKILL.md': 'a'.repeat(64), 'skill.json': 'b'.repeat(64), 'scripts/CON.txt': 'c'.repeat(64) } },
  { files: { 'SKILL.md': 'a'.repeat(64), 'skill.json': 'b'.repeat(64), 'skill.JSON': 'c'.repeat(64) } }
]) test(`strict signed manifest rejects ${JSON.stringify(changes)}`, () => {
  expect(() => fixture('1.0.1', changes).verified()).toThrow()
})

test('unknown signed fields and unsupported app/API are rejected before download', async () => {
  const f = fixture()
  expect(() => verifySkill(envelope({ ...f.manifest, executable: 'oops' }), keys)).toThrow(/항목/)
  for (const change of [{ api: 2 }, { minApp: '0.6.0' }]) {
    const { store } = setup(), { updates, requests } = updater(store, fixture('1.0.1', change))
    expect((await updates.check()).phase).toBe('needs-app')
    await expect(updates.install()).rejects.toThrow(/앱 새 판/)
    expect(requests).toEqual([CHANNEL_URL])
    expect(store.state().highest).toBeNull()
  }
})

for (const [label, transform] of [
  ['added file', (es: Entry[]) => [...es, { name: 'scripts/extra.py', data: Buffer.from('bad') }]],
  ['missing file', (es: Entry[]) => es.slice(0, -1)],
  ['traversal', (es: Entry[]) => [...es, { name: '../escape', data: Buffer.from('bad') }]],
  ['absolute', (es: Entry[]) => [...es, { name: '/escape', data: Buffer.from('bad') }]],
  ['symlink', (es: Entry[]) => es.map(e => e.name === 'scripts/example.py' ? { ...e, mode: 0xa1ff } : e)],
  ['device', (es: Entry[]) => es.map(e => e.name === 'scripts/example.py' ? { ...e, mode: 0x21ff } : e)],
  ['duplicate', (es: Entry[]) => [...es, es[0]]],
  ['decompression bomb', (es: Entry[]) => es.map(e => e.name === 'SKILL.md' ? { ...e, data: Buffer.alloc(100000), method: 8, claimedSize: 10 } : e)],
  ['version mismatch', (es: Entry[]) => es.map(e => e.name === 'skill.json' ? { ...e, data: Buffer.from('{"version":"1.0.2","api":1}') } : e)]
] as const) test(`ZIP rejects ${label} without raising highest or writing outside store`, () => {
  const { store, root } = setup(), f = fixture('1.0.1', {}, transform)
  expect(() => store.publish(f.verified(), f.zip)).toThrow()
  expect(store.state()).toEqual({ active: null, kept: {}, highest: null })
  expect(existsSync(join(root, 'escape'))).toBe(false)
  const good = fixture()
  store.publish(good.verified(), good.zip)
  expect(store.state().highest?.version).toBe('1.0.1')
})

test('archive byte mutation, extracted file mutation, extra/missing files and symlinks cannot become active', () => {
  const { store, bundled } = setup(), f = fixture()
  const bad = Buffer.from(f.zip); bad[40] ^= 1
  expect(() => extractSkill(bad, join(store.root, 'bad'), f.manifest)).toThrow(/확인값/)
  store.publish(f.verified(), f.zip); store.select('1.0.1')
  const file = join(store.root, '1.0.1', 'scripts', 'example.py')
  for (const mutate of [
    () => writeFileSync(file, 'corrupt'),
    () => writeFileSync(join(store.root, '1.0.1', 'extra'), 'bad'),
    () => rmSync(file),
    () => { rmSync(file); symlinkSync(join(bundled, 'SKILL.md'), file) }
  ]) {
    mutate()
    expect(store.resolveSkillSource()).toBe(bundled)
    expect(store.disposition(f.verified())).toBe('repair')
    expect(store.state().highest?.version).toBe('1.0.1')
    store.publish(f.verified(), f.zip)
    expect(store.resolveSkillSource()).toBe(join(store.root, '1.0.1'))
  }
})

test('rollback never lowers highest, old signed replay and same-version replacement fail; restart preserves choice', async () => {
  const { root, bundled, store } = setup()
  for (const v of ['1.0.1', '1.0.2']) { const f = fixture(v); store.publish(f.verified(), f.zip); store.select(v) }
  store.select(store.rollbackTarget())
  expect(store.state().active).toBe('1.0.1')
  expect(store.state().highest?.version).toBe('1.0.2')
  expect(() => store.disposition(fixture('1.0.1').verified())).toThrow(/이전 판/)
  expect(() => store.disposition(fixture('1.0.2', { minApp: '0.5.0' }).verified())).toThrow(/내용이 달라/)
  const restored = new SkillStore(root, bundled, '0.5.1', keys)
  const { updates } = updater(restored, fixture('1.0.2'))
  expect((await updates.check()).phase).toBe('ready')
  expect(restored.state().active).toBe('1.0.1')
  expect(restored.resolveSkillSource()).toBe(join(store.root, '1.0.1'))
  await updates.select('1.0.2')
  expect(restored.state().active).toBe('1.0.2')
})

test('state damage falls back to bundle but highest backup still prevents replay; incomplete atomic tmp is ignored', () => {
  const { root, bundled, store } = setup(), f = fixture('1.0.2')
  store.publish(f.verified(), f.zip); store.select('1.0.2')
  writeFileSync(join(store.root, 'state.json.tmp'), '{')
  expect(store.state().active).toBe('1.0.2')
  writeFileSync(join(store.root, 'state.json'), '{')
  const reopened = new SkillStore(root, bundled, '0.5.1', keys)
  expect(reopened.resolveSkillSource()).toBe(bundled)
  expect(reopened.state().highest?.version).toBe('1.0.2')
  expect(() => reopened.disposition(fixture('1.0.1').verified())).toThrow(/이전 판/)
  expect(reopened.disposition(f.verified())).toBe('repair')
})

test('newer bundle wins and cleanup runs only on explicit startup, retaining active plus previous', () => {
  const { root, bundled, store } = setup()
  for (const v of ['1.0.1', '1.0.2', '1.0.3']) { const f = fixture(v); store.publish(f.verified(), f.zip); store.select(v) }
  expect(existsSync(join(store.root, '1.0.1'))).toBe(true)
  const abandoned = ['.stage-interrupted', '.download-interrupted', '.damaged-1.0.1-1000']
  for (const name of abandoned) mkdirSync(join(store.root, name))
  store.cleanup()
  expect(store.state().kept).toEqual({ '1.0.2': fixture('1.0.2').verified().digest, '1.0.3': fixture('1.0.3').verified().digest })
  expect(existsSync(join(store.root, '1.0.1'))).toBe(false)
  for (const name of abandoned) expect(existsSync(join(store.root, name))).toBe(false)
  writeFileSync(join(bundled, 'skill.json'), JSON.stringify({ version: '1.0.4', api: 1 }))
  const newer = new SkillStore(root, bundled, '0.5.1', keys)
  expect(newer.resolveSkillSource()).toBe(bundled)
  expect(() => newer.select('1.0.3')).toThrow(/사용할 수 없/)
  expect(compare('1.10.0', '1.9.99')).toBe(1)
})

test('packaged ignores all developer overrides, empty production keys reject verification and never fetch', async () => {
  const env = { KNUAF_UPDATE_PUBLIC_KEY: publicKey, KNUAF_UPDATE_CHANNEL_URL: 'http://127.0.0.1:3210/channel.json' }
  expect(updateConfig(false, env)).toEqual({ channel: env.KNUAF_UPDATE_CHANNEL_URL, keys, development: true })
  const packaged = updateConfig(true, env)
  expect(packaged).toEqual({ channel: CHANNEL_URL, keys: [], development: false })
  expect(() => verifySkill(fixture().signed, packaged.keys)).toThrow(/서명/)
  const { store, bundled } = setup('1.0.0', packaged.keys)
  let fetched = false
  const updates = new SkillUpdates(store, { config: packaged, fetch: async () => { fetched = true; throw new Error('must not fetch') }, restartSidecar: async () => {} })
  expect((await updates.check()).phase).toBe('unavailable')
  expect(updates.status().message).toBe('업데이트를 확인할 수 없어요.')
  await expect(updates.install()).rejects.toThrow()
  expect(fetched).toBe(false)
  expect(store.resolveSkillSource()).toBe(bundled)
})

test('redirects to an arbitrary host stop before second request, allowed CDN works, oversized streaming stops', async () => {
  const f = fixture(), signal = new AbortController().signal, requests: string[] = []
  await expect(boundedFetch(f.manifest.url, signal, async url => { requests.push(url); return new Response(null, { status: 302, headers: { location: 'https://evil.example/payload' } }) }, f.zip.length, config())).rejects.toThrow(/이동 주소/)
  expect(requests).toEqual([f.manifest.url])
  const cdn = 'https://release-assets.githubusercontent.com/release-assets/test?token=fake'
  const response = await boundedFetch(f.manifest.url, signal, async url => url === cdn ? new Response(f.zip) : new Response(null, { status: 302, headers: { location: cdn } }), f.zip.length, config())
  expect(Buffer.from(await response.arrayBuffer())).toEqual(f.zip)
  const large = await boundedFetch(f.manifest.url, signal, async () => new Response(Buffer.alloc(10)), 5, config())
  await expect(large.arrayBuffer()).rejects.toThrow(/상한/)
})

test('same-process update downloads and publishes before switch; timeout keeps verified storage and highest', async () => {
  const { store, bundled } = setup(), lock = new SkillSwitch(), release = lock.enter(), { updates } = updater(store, fixture(), async () => {}, lock)
  await updates.check()
  const installation = updates.install()
  await expect.poll(() => store.state().highest?.version).toBe('1.0.1')
  expect(store.resolveSkillSource()).toBe(bundled)
  expect(() => lock.enter()).toThrow(/규칙집/)
  release()
  expect((await installation).current).toBe('1.0.1')
  const held = lock.enter()
  await expect(lock.switch(async () => { throw new Error('must not execute') }, 1)).rejects.toThrow(/작업이 끝난 뒤/)
  held()
  expect(store.state().highest?.version).toBe('1.0.1')
  expect(lock.switching).toBe(false)
})

test('sidecar restart failure restores previous active while keeping newly verified highest; explicit reuse avoids download', async () => {
  const { store, bundled } = setup()
  let attempts = 0
  const { updates, requests } = updater(store, fixture(), async () => { if (++attempts === 1) throw new Error('restart failed') })
  await updates.check()
  await expect(updates.install()).rejects.toThrow('restart failed')
  expect(store.resolveSkillSource()).toBe(bundled)
  expect(store.state().highest?.version).toBe('1.0.1')
  const before = requests.slice()
  await updates.install()
  expect(requests).toEqual(before)
  expect(store.state().active).toBe('1.0.1')
})

test('chat pins one source per send and holds switch admission until the whole turn finishes', async () => {
  const { root, bundled, store } = setup(), f = fixture()
  const project = join(root, 'project'); mkdirSync(project)
  const done = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
  let sourceReads = 0, source = bundled
  const chat = new ChatService({ skillSource: () => { ++sourceReads; return source }, userData: join(root, 'chat'), emit: () => {}, openExternal: async () => {}, connectionFactory: () => ({
    status: async () => ({ installed: true, connected: true, version: null, detail: '' }), login: async () => {}, respond: () => {}, stop: async () => {},
    run: async () => { started.resolve(); await done.promise }
  }) })
  await chat.send(project, 'claude', 'hello', 'request-1'); await started.promise
  const switchDone = skillSwitch.switch(async () => { store.publish(f.verified(), f.zip); store.select('1.0.1'); source = store.resolveSkillSource() })
  expect(() => skillSwitch.enter()).toThrow(/규칙집/)
  expect(sourceReads).toBe(1)
  expect(readFileSync(join(project, '.claude/skills/knuaf-dev/SKILL.md'), 'utf8')).toContain('bundle')
  done.resolve(); await switchDone
  await chat.send(project, 'claude', 'next', 'request-2')
  await chat.stop(project, 'claude')
  expect(sourceReads).toBe(2)
  expect(readFileSync(join(project, '.claude/skills/knuaf-dev/SKILL.md'), 'utf8')).toBe('# skill 1.0.1')
  expect(chat.snapshot(project, 'claude').messages.some(m => m.role === 'system' && m.text.includes('규칙집이 갱신'))).toBe(true)
  const marker = JSON.parse(readFileSync(join(project, '.knuaf-gui/skill-install.json'), 'utf8'))
  expect(marker).toEqual({ schema: 'knuaf-gui/skill-install@1', installs: [{ path: '.claude/skills/knuaf-dev' }, { path: '.agents/skills/knuaf-dev' }] })
  installSkill(bundled, join(project, '.agents/skills/knuaf-dev'), skillVersion(bundled))
  expect(JSON.parse(readFileSync(join(project, '.knuaf-gui/skill-install.json'), 'utf8'))).toEqual(marker)
  await chat.close()
})

test('cancelled streamed download preserves previous state and the next explicit attempt succeeds', async () => {
  const { store, bundled } = setup(), f = fixture(), downloading = Promise.withResolvers<void>()
  let slow = true
  const updates = new SkillUpdates(store, {
    config: config(), lock: new SkillSwitch(), restartSidecar: async () => {},
    fetch: async url => {
      if (url === CHANNEL_URL) return new Response(JSON.stringify({ schema: 1, skill: f.signed }))
      if (!slow) return new Response(f.zip)
      downloading.resolve()
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(f.zip.subarray(0, 10)) } }))
    }
  })
  await updates.check()
  const attempt = updates.install()
  const cancelled = expect(attempt).rejects.toMatchObject({ code: 'runtime_cancelled' })
  await downloading.promise
  expect(updates.cancel()).toBe(true)
  await cancelled
  expect(store.state().highest).toBeNull()
  expect(store.resolveSkillSource()).toBe(bundled)
  slow = false
  expect((await updates.install()).current).toBe('1.0.1')
})

test('repair waits for running consumers before replacing the active directory', async () => {
  const { store } = setup(), f = fixture(), lock = new SkillSwitch()
  store.publish(f.verified(), f.zip); store.select('1.0.1')
  const file = join(store.root, '1.0.1/scripts/example.py')
  writeFileSync(file, 'damaged')
  const release = lock.enter(), { updates } = updater(store, f, async () => {}, lock)
  expect((await updates.check()).phase).toBe('repair')
  const repairing = updates.install()
  await expect.poll(() => lock.switching).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('damaged')
  release()
  expect((await repairing).current).toBe('1.0.1')
  expect(readFileSync(file, 'utf8')).toBe("print('1.0.1')\n")
})

test('signed file count limit and signed skill.json API/version mismatch are enforced', () => {
  const f = fixture(), files = { ...f.manifest.files }
  for (let i = 0; i < 600; i++) files[`scripts/${i}.py`] = 'a'.repeat(64)
  expect(() => fixture('1.0.1', { files }).verified()).toThrow(/파일 목록/)
  for (const metadata of [{ version: '1.0.2', api: 1 }, { version: '1.0.1', api: 2 }]) {
    const bad = fixture('1.0.1', {}, entries => entries.map(e => e.name === 'skill.json' ? { ...e, data: Buffer.from(JSON.stringify(metadata)) } : e))
    bad.manifest.files['skill.json'] = sha256(JSON.stringify(metadata))
    const p = verifySkill(envelope(bad.manifest), keys)
    expect(() => extractSkill(bad.zip, temporary(), p.manifest)).toThrow(/ZIP/)
  }
})

class SelectionSwitch extends SkillSwitch {
  attempts = 0
  override async switch<T>(work: () => Promise<T>, timeout?: number): Promise<T> {
    ++this.attempts
    return super.switch(work, timeout)
  }
}

for (const [label, input] of [
  ['undefined', undefined], ['number', 1], ['object', {}], ['array', []],
  ['relative path', '../escape'], ['absolute path', '/tmp/escape'], ['prerelease', '1.0.1-rc.1']
] as const) test(`select rejects invalid input without side effects: ${label}`, async () => {
  const { store } = setup()
  for (const v of ['1.0.1', '1.0.2']) { const f = fixture(v); store.publish(f.verified(), f.zip) }
  store.select('1.0.1')
  const before = store.state(), lock = new SelectionSwitch(), phases: string[] = []
  let restarts = 0
  const updates = new SkillUpdates(store, {
    config: config(), lock, emit: status => { phases.push(status.phase) },
    fetch: async () => { throw new Error('selection must not fetch') },
    restartSidecar: async () => { ++restarts }
  })
  const status = updates.status()
  await expect(updates.select(input as string | null)).rejects.toThrow()
  expect(store.state()).toEqual(before)
  expect(restarts).toBe(0)
  expect(phases).toEqual([])
  expect(lock.attempts).toBe(0)
  expect(lock.switching).toBe(false)
  expect(updates.status()).toEqual(status)
})

test('select accepts a stored version and null; rollback keeps highest', async () => {
  const { store, bundled } = setup()
  for (const v of ['1.0.1', '1.0.2']) { const f = fixture(v); store.publish(f.verified(), f.zip) }
  store.select('1.0.1')
  const highest = store.state().highest, lock = new SelectionSwitch(), phases: string[] = []
  let restarts = 0
  const updates = new SkillUpdates(store, {
    config: config(), lock, emit: status => { phases.push(status.phase) },
    fetch: async () => { throw new Error('selection must not fetch') },
    restartSidecar: async () => { ++restarts }
  })
  expect((await updates.select('1.0.2')).current).toBe('1.0.2')
  expect(store.resolveSkillSource()).toBe(join(store.root, '1.0.2'))
  expect((await updates.rollback()).current).toBe('1.0.1')
  expect(store.resolveSkillSource()).toBe(join(store.root, '1.0.1'))
  expect((await updates.select(null)).bundled).toBe(true)
  expect(store.state().active).toBeNull()
  expect(store.resolveSkillSource()).toBe(bundled)
  expect(store.state().highest).toEqual(highest)
  expect(restarts).toBe(3)
  expect(lock.attempts).toBe(3)
  expect(phases).toEqual(['switching', 'ready', 'switching', 'ready', 'switching', 'ready'])
})
