import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { composeFiles, fileHashes, jsonBytes, readTree, sha256, zipBytes, writeTree } from '../compose-skill.mjs'
import { releaseManifest, signedChannel } from '../sign-skill.mjs'
import { CONSUMER_TESTS, prepareCompatibility, runCompatibility } from './run-skill-compat.mjs'
import { ACTION_COMMITS, checkWorkflowPins } from './check-skill-workflow.mjs'

const PYTHON = process.env.PYTHON || resolve(import.meta.dirname, '../../../.venv-dev/bin/python')
const composeModule = pathToFileURL(resolve(import.meta.dirname, '../compose-skill.mjs')).href
const source = { repo: 'starceas/knuaf-doc', tag: 'v0.2.0', commit: 'a'.repeat(40) }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'knuaf-r1-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const overlay = join(root, 'overlay'), upstream = join(root, 'upstream'), repo = join(root, 'app-repo')
  mkdirSync(overlay)
  writeFileSync(join(overlay, 'overlay.json'), jsonBytes({ schema: 1, name: 'knuaf-dev', remove: ['tests/', 'install-manifest.json'], append: null }))
  const input = new Map([
    ['SKILL.md', Buffer.from('---\nname: knuaf-doc\n---\n# 원본\n')],
    ['scripts/payload.py', Buffer.from('tested\n')],
    ['references/basic-only.txt', Buffer.from('final-bundle\n')],
    ['references/한글.md', Buffer.from('정상 한글 NFC\n')]
  ])
  const options = { source, overlay, version: '1.0.0' }
  const expected = composeFiles(input, options), bundle = join(root, 'bundle'), archive = join(root, 'skill.zip')
  writeTree(expected, bundle); writeFileSync(archive, zipBytes(expected))
  const upstreamSkill = join(upstream, 'skills/knuaf-doc')
  mkdirSync(join(upstreamSkill, 'tests'), { recursive: true })
  writeFileSync(join(upstreamSkill, 'SKILL.md'), '---\nname: knuaf-doc\n---\n')
  mkdirSync(join(upstreamSkill, 'references'))
  writeFileSync(join(upstreamSkill, 'references/basic-only.txt'), 'source-not-final\n')
  mkdirSync(join(repo, 'tests'), { recursive: true })
  mkdirSync(join(repo, 'app/sidecar'), { recursive: true })
  for (const name of CONSUMER_TESTS) writeFileSync(join(repo, 'tests', name), `from pathlib import Path\ndef test_final_payload():\n    body = Path(__file__).resolve().parents[1] / 'skills/knuaf-dev'\n    assert (body / 'scripts/payload.py').read_text() == 'tested\\n'\n    assert 'name: knuaf-dev' in (body / 'SKILL.md').read_text()\n`)
  const basicCode = `import os, subprocess\nfrom pathlib import Path\ndef test_composed_body():\n    body = Path(__file__).resolve().parents[1]\n    assert (body / 'references/basic-only.txt').read_text() == 'final-bundle\\n'\n    assert 'name: ' + os.environ['KNUAF_SKILL_TEST_NAME'] in (body / 'SKILL.md').read_text()\n    assert os.environ['KNUAF_SKILL_TEST_SOURCE_NAME'] == 'knuaf-doc'\n    assert Path(os.environ['D1_TEST_RUNTIME']).resolve() == body\n    if os.environ.get('W2_TEST_ATTACK'):\n        subprocess.check_call([os.environ['W2_TEST_NODE'], '--input-type=module', '-e', os.environ['W2_TEST_ATTACK']])\n`
  writeFileSync(join(upstreamSkill, 'tests/test_basic.py'), basicCode)
  return { root, overlay, upstream, upstreamSkill, repo, input, options, expected, bundle, archive, basicCode,
    expectedZip: sha256(readFileSync(archive)) }
}

function attackCode(f) {
  // Simulates code executed by an upstream test or a dependency install hook.
  // It changes all three files consistently, so directory/ZIP self-consistency is not enough.
  return `import {writeFileSync} from 'node:fs'; import {readTree,fileHashes,jsonBytes,zipBytes} from ${JSON.stringify(composeModule)};
  const root=${JSON.stringify(f.bundle)}; writeFileSync(root+'/scripts/payload.py','untested\\n');
  const files=readTree(root); files.delete('install-manifest.json');
  const manifest=jsonBytes({files:fileHashes(files),schema:'knuaf-doc/install-manifest@1'});
  writeFileSync(root+'/install-manifest.json',manifest); files.set('install-manifest.json',manifest);
  writeFileSync(${JSON.stringify(f.archive)},zipBytes(files));`
}

function resultManifest(f) {
  // This in-memory composition is outside the untrusted child process, modeling the fresh signing job.
  return releaseManifest({ directory: f.bundle, archive: f.archive, minApp: '0.6.0', expectedFiles: composeFiles(f.input, f.options) })
}

test('R1-01/R1-04 normal final bundle passes both actual test suites and signs independently composed bytes', t => {
  const f = fixture(t)
  const outcome = runCompatibility({ ...f, python: PYTHON })
  assert.deepEqual(outcome, { consumer: 0, basic: 0, candidateValid: true, ok: true })
  const manifest = resultManifest(f)
  assert.deepEqual(manifest.files, fileHashes(f.expected))
  const keys = generateKeyPairSync('ed25519')
  const bytes = jsonBytes(manifest)
  const channel = signedChannel({ schema: 1 }, bytes, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  assert.equal(verify(null, bytes, keys.publicKey, Buffer.from(channel.skill.sig, 'base64')), true)
  assert.deepEqual(readFileSync(f.archive), zipBytes(f.expected))
})

test('R1-01 upstream test replacing bundle+install-manifest+ZIP cannot obtain a release manifest/signature', t => {
  const f = fixture(t)
  const before = sha256(readFileSync(f.archive))
  const previous = { attack: process.env.W2_TEST_ATTACK, node: process.env.W2_TEST_NODE }
  process.env.W2_TEST_ATTACK = attackCode(f); process.env.W2_TEST_NODE = process.execPath
  t.after(() => {
    if (previous.attack === undefined) delete process.env.W2_TEST_ATTACK; else process.env.W2_TEST_ATTACK = previous.attack
    if (previous.node === undefined) delete process.env.W2_TEST_NODE; else process.env.W2_TEST_NODE = previous.node
  })
  assert.deepEqual(runCompatibility({ ...f, python: PYTHON }), { consumer: 0, basic: 0, candidateValid: false, ok: false })
  assert.notEqual(sha256(readFileSync(f.archive)), before)
  assert.deepEqual(readFileSync(f.archive), zipBytes(readTree(f.bundle)))
  assert.equal(JSON.parse(readFileSync(join(f.bundle, 'install-manifest.json'))).files['scripts/payload.py'], sha256(Buffer.from('untested\n')))
  assert.throws(() => resultManifest(f), /differ from independent composition/)
})

test('R1-01 dependency hook replacing the same three inputs cannot obtain a signature', t => {
  const f = fixture(t)
  execFileSync(process.execPath, ['--input-type=module', '-e', attackCode(f)])
  assert.deepEqual(readFileSync(f.archive), zipBytes(readTree(f.bundle)))
  assert.deepEqual(runCompatibility({ ...f, python: PYTHON }), { consumer: null, basic: null, candidateValid: false, ok: false })
  assert.throws(() => resultManifest(f), /differ from independent composition/)
  assert.throws(() => releaseManifest({ directory: f.bundle, archive: f.archive, minApp: '0.6.0' }), /Independent composition is required/)
})

test('R1-04 changing a file observed only by upstream basic tests makes that suite fail', t => {
  const f = fixture(t)
  f.input.set('references/basic-only.txt', Buffer.from('changed-final-bundle\n'))
  f.expected = composeFiles(f.input, f.options)
  for (const [path, bytes] of f.expected) writeFileSync(join(f.bundle, path), bytes)
  writeFileSync(f.archive, zipBytes(f.expected))
  f.expectedZip = sha256(readFileSync(f.archive))
  const outcome = runCompatibility({ ...f, python: PYTHON })
  assert.equal(outcome.consumer, 0)
  assert.equal(outcome.basic, 1)
  assert.equal(outcome.candidateValid, true)
  assert.equal(outcome.ok, false)
  assert.equal(readFileSync(join(f.upstreamSkill, 'references/basic-only.txt'), 'utf8'), 'source-not-final\n')
})

test('R1-04 layout/name adapters preserve upstream test code and the complete composed body', t => {
  const f = fixture(t), scratch = join(f.root, 'prepared')
  const roots = prepareCompatibility(f, scratch)
  assert.equal(readFileSync(join(roots.skill, 'tests/test_basic.py'), 'utf8'), f.basicCode)
  for (const [path, bytes] of f.expected) assert.deepEqual(readFileSync(join(roots.skill, path)), bytes)
  assert.match(readFileSync(join(roots.skill, 'SKILL.md'), 'utf8'), /^name: knuaf-dev$/m)
  assert.equal(readFileSync(join(roots.skill, 'references/basic-only.txt'), 'utf8'), 'final-bundle\n')
})

for (const path of ['references/cafe\u0301.md', 'references/CON.txt', 'references/a?.md', 'references/trailing.', 'references/delete\u007f.md']) {
  test(`R1-03 rejects review path ${JSON.stringify(path)} during compose`, t => {
    const f = fixture(t)
    f.input.set(path, Buffer.from('unsafe'))
    assert.throws(() => composeFiles(f.input, f.options), /Unsafe skill path/)
  })
}

test('R1-03 rejects remaining Windows aliases, file/folder collisions and unsafe-integer versions', t => {
  const f = fixture(t)
  for (const path of ['references/ending ', 'references/Lpt9.data', 'references/a<b', 'references/a|b', 'references/a*b', 'references/a"b']) {
    const input = new Map(f.input); input.set(path, Buffer.from('x'))
    assert.throws(() => composeFiles(input, f.options), /Unsafe skill path/)
  }
  const colliding = new Map(f.input); colliding.set('references', Buffer.from('file'))
  assert.throws(() => composeFiles(colliding, f.options), /path collision/)
  assert.throws(() => composeFiles(f.input, { ...f.options, version: '9007199254740992.0.0' }), /Invalid version/)
  assert.throws(() => releaseManifest({ directory: f.bundle, archive: f.archive, minApp: '0.9007199254740992.0', expectedFiles: f.expected }), /safe-integer/)
})

test('R1-02 immutable action policy accepts resolved commits and rejects any mutable/unreviewed reference', () => {
  const pins = Object.entries(ACTION_COMMITS).map(([repo, sha]) => `      - uses: ${repo}@${sha} # reviewed tag`).join('\n')
  assert.equal(checkWorkflowPins(pins).length, 6)
  for (const [repo, sha] of Object.entries(ACTION_COMMITS)) {
    for (const ref of ['v4', 'main', sha.slice(0, 12), '0'.repeat(40), '${{ inputs.ref }}']) {
      assert.throws(() => checkWorkflowPins(pins.replace(`${repo}@${sha}`, `${repo}@${ref}`)), /Unreviewed or mutable/)
    }
  }
  assert.throws(() => checkWorkflowPins(pins + '\n      - uses: actions/checkout@v4'), /Unreviewed or mutable/)
})
