import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname, relative, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
export const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const validVersion = (value) => typeof value === 'string' && VERSION.test(value) &&
  value.split('.').every(n => Number.isSafeInteger(Number(n)))
export const MAX_BYTES = 80 * 1024 * 1024
export const MAX_FILES = 600

export function safePath(path) {
  // Same contract as W1 update/manifest.ts: archive names are never silently normalized.
  if (typeof path !== 'string' || !path || path !== path.normalize('NFC') ||
      path.includes('\\') || /[\x00-\x1f\x7f:]/.test(path) ||
      path.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) ||
        /[<>"|?*]/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error(`Unsafe skill path: ${path}`)
  }
  return path
}

export function readTree(root) {
  const files = new Map()
  function visit(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const path = prefix + name
      safePath(path)
      const full = resolve(dir, name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw new Error(`Symlink forbidden: ${path}`)
      if (stat.isDirectory()) visit(full, path + '/')
      else if (stat.isFile()) files.set(path, readFileSync(full))
      else throw new Error(`Special file forbidden: ${path}`)
    }
  }
  visit(root)
  return files
}

const sorted = (files) => [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
export function fileHashes(files) {
  return Object.fromEntries(sorted(files).map(([path, bytes]) => [path, sha256(bytes)]))
}

export function overlayHash(overlay) {
  return sha256(jsonBytes(fileHashes(readTree(overlay))))
}

export function checkSource(source, upstream) {
  if (source.repo !== 'starceas/knuaf-doc' || !/^v\d+\.\d+\.\d+$/.test(source.tag) ||
      !/^[a-f0-9]{40}$/.test(source.commit)) throw new Error('Invalid pinned source')
  const git = (...args) => execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8' }).trim()
  if (git('rev-parse', 'HEAD') !== source.commit || git('rev-parse', `${source.tag}^{commit}`) !== source.commit) {
    throw new Error('Source HEAD/tag does not match pinned commit')
  }
  // The composed bytes must come from the pinned tree, not local modifications.
  if (git('status', '--porcelain', '--untracked-files=all', '--', 'skills/knuaf-doc')) {
    throw new Error('Source skill tree is dirty')
  }
}

export function compose({ upstream, source, overlay, version, api = 1 }) {
  checkSource(source, upstream)
  return composeFiles(readTree(resolve(upstream, 'skills/knuaf-doc')), { source, overlay, version, api })
}

export function composeFiles(input, { source, overlay, version, api = 1 }) {
  if (!validVersion(version) || !Number.isSafeInteger(api) || api < 1) throw new Error('Invalid version/api')
  const files = new Map(input)
  for (const path of files.keys()) {
    if (path.split('/').includes('tests') || path === 'install-manifest.json') files.delete(path)
  }
  const overlayFiles = readTree(overlay)
  const config = JSON.parse(overlayFiles.get('overlay.json')?.toString() ?? 'null')
  if (!config || Object.keys(config).sort().join(',') !== 'append,name,remove,schema' ||
      config.schema !== 1 || config.name !== 'knuaf-dev' || !Array.isArray(config.remove) ||
      config.remove.some(p => !['tests/', 'install-manifest.json'].includes(p)) ||
      (config.append !== null && config.append !== 'app-section.md')) throw new Error('Invalid overlay policy')
  for (const [path, bytes] of overlayFiles) {
    if (path === 'overlay.json' || (path === 'app-section.md' && config.append)) continue
    if (!path.startsWith('files/')) throw new Error(`Unknown overlay file: ${path}`)
    const target = safePath(path.slice(6))
    if (!/^(references|assets)\//.test(target) || files.has(target)) {
      throw new Error(`Overlay can only add new references/assets: ${target}`)
    }
    files.set(target, bytes)
  }
  const skill = files.get('SKILL.md')?.toString('utf8')
  if (!skill || !/^---\r?\n/.test(skill)) throw new Error('Missing SKILL.md frontmatter')
  const end = skill.indexOf('\n---', 4)
  const header = skill.slice(0, end)
  if (end < 0 || !/^name: knuaf-doc\r?$/m.test(header)) throw new Error('Unexpected source skill name')
  let renamed = header.replace(/^name: knuaf-doc\r?$/m, 'name: knuaf-dev') + skill.slice(end)
  if (config.append) {
    const start = '<!-- knuaf-dev:app:start -->'
    const finish = '<!-- knuaf-dev:app:end -->'
    const body = overlayFiles.get(config.append)?.toString('utf8')
    if (!body || renamed.includes(start) || body.includes(start) || body.includes(finish)) throw new Error('Invalid app section markers')
    renamed = renamed.trimEnd() + `\n\n${start}\n${body.trim()}\n${finish}\n`
  }
  files.set('SKILL.md', Buffer.from(renamed))
  files.set('skill.json', jsonBytes({ version, api, source, overlay: overlayHash(overlay) }))
  // The install manifest cannot hash itself. The signed release manifest hashes it too.
  files.set('install-manifest.json', jsonBytes({ files: fileHashes(files), schema: 'knuaf-doc/install-manifest@1' }))
  assertLimits(files)
  return new Map(sorted(files))
}

export function assertLimits(files) {
  let size = 0
  const folded = new Set()
  for (const [path, bytes] of files) {
    safePath(path)
    const key = path.normalize('NFC').toLowerCase()
    if (folded.has(key)) throw new Error(`Case/Unicode path collision: ${path}`)
    folded.add(key)
    size += bytes.length
  }
  for (const path of files.keys()) {
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
      if (folded.has(path.slice(0, i).toLowerCase())) throw new Error(`File/directory path collision: ${path}`)
    }
  }
  if (files.size > MAX_FILES || size > MAX_BYTES) throw new Error('Skill extraction limits exceeded')
}

// ZIP32 STORE: sorted UTF-8 file names, 1980-01-01, regular 0644 files, no extra fields.
// No compressor/platform timestamp variance and no external archive dependency.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
export function zipBytes(files) {
  assertLimits(files)
  const local = [], central = []
  let offset = 0, centralSize = 0
  for (const [path, bytes] of sorted(files)) {
    const name = Buffer.from(path)
    const crc = crc32(bytes)
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6)
    h.writeUInt16LE(33, 12); h.writeUInt32LE(crc, 14)
    h.writeUInt32LE(bytes.length, 18); h.writeUInt32LE(bytes.length, 22); h.writeUInt16LE(name.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314, 4); c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0x800, 8); c.writeUInt16LE(33, 14); c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(bytes.length, 20); c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(name.length, 28)
    c.writeUInt32LE(0x81a40000, 38); c.writeUInt32LE(offset, 42)
    local.push(h, name, bytes); central.push(c, name)
    offset += h.length + name.length + bytes.length
    centralSize += c.length + name.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10)
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

export function writeTree(files, output) {
  if (existsSync(output) && readdirSync(output).length) throw new Error('Output directory must be empty')
  mkdirSync(output, { recursive: true })
  for (const [path, bytes] of files) {
    const dest = resolve(output, path)
    const rel = relative(output, dest)
    if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('Output escapes root')
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, bytes, { mode: 0o644 })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    upstream: { type: 'string' }, source: { type: 'string', default: resolve(import.meta.dirname, '../skill-source.json') },
    overlay: { type: 'string', default: resolve(import.meta.dirname, '../skill-overlay') },
    output: { type: 'string' }, zip: { type: 'string' }, version: { type: 'string', default: '1.0.0' }
  } })
  if (!values.upstream || !values.output) throw new Error('--upstream and --output are required')
  const files = compose({ ...values, source: JSON.parse(readFileSync(values.source, 'utf8')) })
  writeTree(files, resolve(values.output))
  if (values.zip) writeFileSync(values.zip, zipBytes(files))
  console.log(`Composed ${files.size} files (${values.version})`)
}
