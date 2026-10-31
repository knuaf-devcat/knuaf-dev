// Packaging and release use exactly the same pinned-source composition.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { compose, writeTree } from './compose-skill.mjs'

const app = resolve(import.meta.dirname, '..')
const channel = JSON.parse(readFileSync(resolve(app, '../updates/channel.json'), 'utf8'))
const { values } = parseArgs({ options: {
  upstream: { type: 'string' },
  output: { type: 'string', default: resolve(app, 'resources/skill') },
  version: { type: 'string', default: channel.skill?.version ?? '1.0.0' }
} })
const source = JSON.parse(readFileSync(resolve(app, 'skill-source.json'), 'utf8'))
const temp = mkdtempSync(join(tmpdir(), 'knuaf-stage-'))
try {
  let upstream = values.upstream
  if (!upstream) {
    upstream = join(temp, 'upstream')
    execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', source.tag,
      `https://github.com/${source.repo}.git`, upstream], { stdio: 'pipe' })
  }
  const files = compose({ upstream, source, overlay: resolve(app, 'skill-overlay'), version: values.version })
  // Compose failures leave the previous staged bundle untouched.
  if (existsSync(values.output)) rmSync(values.output, { recursive: true })
  // writeTree supports cross-volume build/resource directories.
  writeTree(files, values.output)
  console.log(`staged ${files.size} skill files → ${values.output}`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
