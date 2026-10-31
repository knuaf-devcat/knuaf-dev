import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { composeFiles, jsonBytes, sha256, zipBytes, writeTree, fileHashes, readTree, assertLimits, overlayHash } from '../compose-skill.mjs'
import { signManifest, releaseManifest, signedChannel } from '../sign-skill.mjs'

const source = { repo: 'starceas/knuaf-doc', tag: 'v0.2.0', commit: 'a'.repeat(40) }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'knuaf-w2-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const overlay = join(root, 'overlay')
  mkdirSync(overlay)
  const policy = { schema: 1, name: 'knuaf-dev', remove: ['tests/', 'install-manifest.json'], append: null }
  writeFileSync(join(overlay, 'overlay.json'), jsonBytes(policy))
  const input = new Map([
    ['SKILL.md', Buffer.from('---\nname: knuaf-doc\ndescription: 시험\n---\n# 원본\n')],
    ['scripts/gg_update.py', Buffer.from('print("managed")\n')],
    ['references/한글.md', Buffer.from('원본 문서\n')],
    ['tests/test_source.py', Buffer.from('test')],
    ['install-manifest.json', Buffer.from('stale')]
  ])
  const options = { source, overlay, version: '1.0.0' }
  return { root, overlay, policy, input, options, build: () => composeFiles(input, options) }
}

test('composition is byte deterministic; rewritten install manifest covers final renamed content', t => {
  const f = fixture(t)
  const first = f.build()
  utimesSync(join(f.overlay, 'overlay.json'), new Date(), new Date())
  const second = composeFiles(new Map([...f.input].reverse()), f.options)
  assert.deepEqual(zipBytes(first), zipBytes(second))
  assert.match(first.get('SKILL.md').toString(), /^name: knuaf-dev$/m)
  assert.equal(first.has('tests/test_source.py'), false)
  assert.deepEqual(first.get('scripts/gg_update.py'), f.input.get('scripts/gg_update.py'))
  const install = JSON.parse(first.get('install-manifest.json'))
  const expected = new Map(first); expected.delete('install-manifest.json')
  assert.deepEqual(install.files, fileHashes(expected))
  assert.equal(JSON.parse(first.get('skill.json')).overlay, overlayHash(f.overlay))
})

test('ZIP is readable independently with fixed dates, regular modes and valid CRCs', t => {
  const f = fixture(t), files = f.build(), zip = join(f.root, 'skill.zip')
  writeFileSync(zip, zipBytes(files))
  const python = process.env.PYTHON || 'python3'
  const output = execFileSync(python, ['-c',
    'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert all(i.date_time == (1980,1,1,0,0,0) and i.external_attr >> 16 == 0o100644 for i in z.infolist()); print(json.dumps({i.filename:z.read(i).hex() for i in z.infolist()}))', zip], { encoding: 'utf8' })
  assert.deepEqual(JSON.parse(output), Object.fromEntries([...files].map(([p, b]) => [p, b.toString('hex')])))
})

test('only additive app docs/assets and marked app section are accepted', t => {
  const f = fixture(t)
  mkdirSync(join(f.overlay, 'files/references'), { recursive: true })
  writeFileSync(join(f.overlay, 'files/references/app.md'), '앱 전용')
  f.policy.append = 'app-section.md'
  writeFileSync(join(f.overlay, 'overlay.json'), jsonBytes(f.policy))
  writeFileSync(join(f.overlay, 'app-section.md'), '## 앱 안에서 쓸 때\n앱 문단')
  const first = f.build()
  assert.equal(first.get('references/app.md').toString(), '앱 전용')
  assert.match(first.get('SKILL.md').toString(), /<!-- knuaf-dev:app:start -->\n## 앱 안에서 쓸 때\n앱 문단\n<!-- knuaf-dev:app:end -->/)
  const hash = overlayHash(f.overlay)
  writeFileSync(join(f.overlay, 'app-section.md'), '바뀐 문단')
  assert.notEqual(overlayHash(f.overlay), hash)
  writeFileSync(join(f.overlay, 'files/references/한글.md'), 'override')
  assert.throws(f.build, /only add/)
})

test('script patches, arbitrary deletion, links, unsafe paths and extraction limits fail closed', t => {
  const f = fixture(t)
  mkdirSync(join(f.overlay, 'files/scripts'), { recursive: true })
  const patch = join(f.overlay, 'files/scripts/gg_update.py')
  writeFileSync(patch, 'patch')
  assert.throws(f.build, /only add/)
  rmSync(patch)
  f.policy.remove.push('scripts/gg_update.py')
  writeFileSync(join(f.overlay, 'overlay.json'), jsonBytes(f.policy))
  assert.throws(f.build, /Invalid overlay/)
  symlinkSync(join(f.overlay, 'overlay.json'), join(f.root, 'link'))
  assert.throws(() => readTree(f.root), /Symlink/)
  for (const path of ['../bad', '/abs', 'a//b', 'a\\b', 'C:/bad']) assert.throws(() => zipBytes(new Map([[path, Buffer.from('x')]])), /Unsafe/)
  assert.throws(() => assertLimits(new Map([['A', Buffer.alloc(0)], ['a', Buffer.alloc(0)]])), /collision/)
  assert.throws(() => assertLimits(new Map(Array.from({ length: 601 }, (_, i) => [`f${i}`, Buffer.alloc(0)]))), /limits/)
  assert.throws(() => assertLimits(new Map([['big', Buffer.alloc(80 * 1024 * 1024 + 1)]])), /limits/)
  f.options.version = '1.0.0-beta'
  assert.throws(f.build, /Invalid version/)
})

test('signer binds exact manifest bytes, archive and every file; preserves app channel', t => {
  const f = fixture(t), files = f.build(), directory = join(f.root, 'skill'), archive = join(f.root, 'skill.zip')
  writeTree(files, directory); writeFileSync(archive, zipBytes(files))
  const manifest = releaseManifest({ directory, archive, minApp: '0.6.0', expectedFiles: f.build() })
  assert.deepEqual(manifest.files, fileHashes(files))
  assert.equal(manifest.sha256, sha256(readFileSync(archive)))
  const key = generateKeyPairSync('ed25519')
  const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' })
  const bytes = jsonBytes(manifest)
  const channel = signedChannel({ schema: 1, app: { latest: '0.6.0', page: 'unchanged' } }, bytes, pem)
  assert.deepEqual(channel.app, { latest: '0.6.0', page: 'unchanged' })
  assert.deepEqual(Buffer.from(channel.skill.manifest, 'base64'), bytes)
  assert.equal(verify(null, bytes, key.publicKey, Buffer.from(channel.skill.sig, 'base64')), true)
  const tampered = Buffer.from(bytes); tampered[1] ^= 1
  assert.equal(verify(null, tampered, key.publicKey, Buffer.from(channel.skill.sig, 'base64')), false)
  assert.equal(verify(null, bytes, generateKeyPairSync('ed25519').publicKey, Buffer.from(channel.skill.sig, 'base64')), false)
  const badZip = readFileSync(archive); badZip[35] ^= 1; writeFileSync(archive, badZip)
  assert.throws(() => releaseManifest({ directory, archive, minApp: '0.6.0', expectedFiles: f.build() }), /Archive bytes/)
  assert.throws(() => signManifest(bytes, 'not a key'), /Invalid signing key/)
})

test('shared W1 vector verifies original bytes and rejects one-byte mutation', () => {
  const vector = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/skill-signature-vector.json'), 'utf8'))
  const bytes = Buffer.from(vector.manifest, 'base64'), sig = Buffer.from(vector.sig, 'base64')
  assert.equal(verify(null, bytes, vector.publicKey, sig), true)
  bytes[vector.mutation.offset] ^= vector.mutation.xor
  assert.equal(verify(null, bytes, vector.publicKey, sig), false)
})
