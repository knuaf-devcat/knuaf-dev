// postinstall: node-pty's spawn-helper reaches the pnpm store without the execute bit, so
// pty.spawn fails with "posix_spawnp failed". Restore +x on every spawn-helper we can find
// (prebuilds and a local build/Release), then electron-builder ships the right mode too.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
let pkg
try { pkg = require.resolve('node-pty/package.json') } catch { process.exit(0) }
const root = dirname(pkg)
const candidates = [join(root, 'build', 'Release', 'spawn-helper')]
const prebuilds = join(root, 'prebuilds')
if (existsSync(prebuilds)) for (const dir of readdirSync(prebuilds)) candidates.push(join(prebuilds, dir, 'spawn-helper'))
for (const helper of candidates) if (existsSync(helper)) chmodSync(helper, 0o755)
