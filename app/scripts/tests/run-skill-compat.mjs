// Both suites read the final composed body; only their test code/layout differs.
import { cpSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { sha256, zipBytes, readTree } from '../compose-skill.mjs'

export const CONSUMER_TESTS = [
  'test_sidecar.py', 'test_sidecar_read_all.py', 'test_build_docx.py', 'test_excel_template.py',
  'test_excel_fill.py', 'test_excel_formula_patch.py', 'test_office_static.py', 'test_deps.py', 'test_kordoc.py'
]
const REPO = resolve(import.meta.dirname, '../../..')

export function prepareCompatibility({ bundle, upstream, repo = REPO }, temp) {
  const consumer = join(temp, 'consumer')
  cpSync(resolve(repo, 'tests'), join(consumer, 'tests'), { recursive: true })
  cpSync(resolve(repo, 'app/sidecar'), join(consumer, 'app/sidecar'), { recursive: true })
  mkdirSync(join(consumer, 'skills'), { recursive: true })
  cpSync(resolve(bundle), join(consumer, 'skills/knuaf-dev'), { recursive: true })

  const basic = join(temp, 'upstream')
  const original = resolve(upstream)
  cpSync(original, basic, {
    recursive: true,
    filter: path => {
      const rel = relative(original, path).split(/[\\/]/)
      return !rel.some(p => p === '.git' || p === '__pycache__') && rel.join('/') !== 'skills/knuaf-doc'
    }
  })
  // Explicit layout adapter: upstream tests retain their source path and exact code,
  // but every runtime file underneath it comes from the final knuaf-dev bundle.
  // Do not rewrite SKILL.md back to knuaf-doc or intercept reads/assertions.
  const skill = join(basic, 'skills/knuaf-doc')
  cpSync(resolve(bundle), skill, { recursive: true })
  cpSync(join(original, 'skills/knuaf-doc/tests'), join(skill, 'tests'), { recursive: true })
  return { consumer, basic, skill }
}

// This digest comes from the separate pre-test compose job, never a checksum in this workspace.
function candidateMatches(bundle, archive, expectedZip) {
  if (!/^[a-f0-9]{64}$/.test(expectedZip ?? '')) throw new Error('Trusted pre-test ZIP digest is required')
  const zip = readFileSync(archive)
  return sha256(zip) === expectedZip && zip.equals(zipBytes(readTree(bundle)))
}

export function runCompatibility({ bundle, upstream, archive, expectedZip, python = 'python3', repo = REPO }) {
  if (!candidateMatches(bundle, archive, expectedZip)) {
    console.error('Candidate changed before compatibility tests (including dependency setup)')
    return { consumer: null, basic: null, candidateValid: false, ok: false }
  }
  const temp = mkdtempSync(join(tmpdir(), 'knuaf-compat-'))
  try {
    const roots = prepareCompatibility({ bundle, upstream, repo }, temp)
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    const consumer = spawnSync(python, ['-m', 'pytest', '-q', ...CONSUMER_TESTS.map(p => join(roots.consumer, 'tests', p))], {
      cwd: roots.consumer, stdio: 'inherit', timeout: 30 * 60 * 1000, env
    })
    const basic = spawnSync(python, ['-m', 'pytest', '-q', join(roots.skill, 'tests')], {
      cwd: roots.basic, stdio: 'inherit', timeout: 60 * 60 * 1000,
      env: {
        ...env,
        // Documented adapters for tests that support explicit runtime/name parameters.
        // Tests that hardcode incompatible names still fail; none are skipped or monkeypatched.
        D1_TEST_RUNTIME: roots.skill, KNUAF_SKILL_TEST_NAME: 'knuaf-dev', KNUAF_SKILL_TEST_SOURCE_NAME: 'knuaf-doc'
      }
    })
    if (consumer.error) console.error(consumer.error.message)
    if (basic.error) console.error(basic.error.message)
    const candidateValid = candidateMatches(bundle, archive, expectedZip)
    if (!candidateValid) console.error('Candidate changed during compatibility tests')
    return { consumer: consumer.status, basic: basic.status, candidateValid,
      ok: consumer.status === 0 && basic.status === 0 && candidateValid }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    bundle: { type: 'string' }, upstream: { type: 'string' }, zip: { type: 'string' },
    'expected-zip-sha256': { type: 'string' }, python: { type: 'string', default: 'python3' }
  } })
  if (!values.bundle || !values.upstream || !values.zip || !values['expected-zip-sha256']) {
    throw new Error('--bundle, --upstream, --zip and --expected-zip-sha256 are required')
  }
  process.exitCode = runCompatibility({ ...values, archive: values.zip, expectedZip: values['expected-zip-sha256'] }).ok ? 0 : 1
}
