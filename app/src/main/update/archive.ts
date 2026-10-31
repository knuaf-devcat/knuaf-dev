import { inflateRawSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAX_BYTES, MAX_FILES, safePath, sha256, type SkillManifest } from './manifest'

/** ZIP32 only: central/local agreement, no encryption, links, devices, aliases or ZIP64.
 * Nothing is written until every entry, decompression bound and signed hash passes. */
export function extractSkill(zip: Buffer, destination: string, manifest: SkillManifest): void {
  if (zip.length !== manifest.size || zip.length > MAX_BYTES || sha256(zip) !== manifest.sha256) throw new Error('규칙집 묶음 확인값이 달라요.')
  const fail = (): never => { throw new Error('안전하지 않거나 손상된 ZIP 묶음이에요.') }
  const bounds = (p: number, n: number): void => { if (p < 0 || n < 0 || p + n > zip.length) fail() }
  let end = zip.length - 22
  for (; end >= Math.max(0, zip.length - 65557); end--) if (zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length) break
  bounds(end, 22)
  const count = zip.readUInt16LE(end + 10), centralSize = zip.readUInt32LE(end + 12), central = zip.readUInt32LE(end + 16)
  if (zip.readUInt32LE(end) !== 0x06054b50 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 8) !== count || count > MAX_FILES * 2 || central + centralSize !== end) fail()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const seen = new Set<string>(), files = new Map<string, Buffer>(), ranges: [number, number][] = []
  let p = central, total = 0
  for (let i = 0; i < count; i++) {
    bounds(p, 46)
    if (zip.readUInt32LE(p) !== 0x02014b50 || zip.readUInt16LE(p + 34)) fail()
    const flags = zip.readUInt16LE(p + 8), method = zip.readUInt16LE(p + 10), crc = zip.readUInt32LE(p + 16)
    const packed = zip.readUInt32LE(p + 20), size = zip.readUInt32LE(p + 24)
    const n = zip.readUInt16LE(p + 28), extra = zip.readUInt16LE(p + 30), comment = zip.readUInt16LE(p + 32), local = zip.readUInt32LE(p + 42)
    bounds(p + 46, n + extra + comment)
    if (flags & ~0x808 || ![0, 8].includes(method) || size > MAX_BYTES || packed > MAX_BYTES) fail()
    const nameBytes = zip.subarray(p + 46, p + 46 + n), raw = decoder.decode(nameBytes), directory = raw.endsWith('/'), name = directory ? raw.slice(0, -1) : raw
    safePath(name)
    const alias = name.toLowerCase()
    if (seen.has(alias)) fail()
    seen.add(alias)
    const attrs = zip.readUInt32LE(p + 38), mode = attrs >>> 16, kind = mode & 0xf000
    if ((kind && kind !== (directory ? 0x4000 : 0x8000)) || (!!(attrs & 0x10) && !directory)) fail()
    // ZIP64 and Unicode path extra fields can reinterpret sizes/names differently.
    const checkExtra = (start: number, length: number): void => {
      let q = start
      while (q < start + length) {
        if (q + 4 > start + length) fail()
        const id = zip.readUInt16LE(q), len = zip.readUInt16LE(q + 2)
        if (id === 1 || id === 0x7075 || q + 4 + len > start + length) fail()
        q += 4 + len
      }
    }
    checkExtra(p + 46 + n, extra)
    bounds(local, 30)
    if (zip.readUInt32LE(local) !== 0x04034b50 || zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method) fail()
    const ln = zip.readUInt16LE(local + 26), le = zip.readUInt16LE(local + 28), data = local + 30 + ln + le
    bounds(local + 30, ln + le); bounds(data, packed)
    if (!zip.subarray(local + 30, local + 30 + ln).equals(nameBytes) || data + packed > central) fail()
    checkExtra(local + 30 + ln, le)
    if (!(flags & 8) && (zip.readUInt32LE(local + 14) !== crc || zip.readUInt32LE(local + 18) !== packed || zip.readUInt32LE(local + 22) !== size)) fail()
    let finish = data + packed
    if (flags & 8) {
      bounds(finish, 12)
      if (zip.readUInt32LE(finish) === 0x08074b50) { finish += 4; bounds(finish, 12) }
      if (zip.readUInt32LE(finish) !== crc || zip.readUInt32LE(finish + 4) !== packed || zip.readUInt32LE(finish + 8) !== size) fail()
      finish += 12
    }
    if (finish > central) fail()
    ranges.push([local, finish])
    total += size
    if (total > MAX_BYTES || (directory && (size || packed))) fail()
    if (!directory) {
      if (!Object.hasOwn(manifest.files, name) || files.size >= MAX_FILES) fail()
      const compressed = zip.subarray(data, data + packed)
      const bytes = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) })
      if (bytes.length !== size || sha256(bytes) !== manifest.files[name]) fail()
      files.set(name, bytes)
    }
    p += 46 + n + extra + comment
  }
  ranges.sort((a, b) => a[0] - b[0])
  for (let i = 0; i < ranges.length; i++) if (ranges[i][0] !== (i ? ranges[i - 1][1] : 0)) fail()
  if (p !== end || !ranges.length || ranges[ranges.length - 1][1] !== central || files.size !== Object.keys(manifest.files).length) fail()
  const metadata = JSON.parse(decoder.decode(files.get('skill.json')!))
  if (metadata?.version !== manifest.version || metadata?.api !== manifest.api) fail()
  for (const [name, bytes] of files) {
    const path = join(destination, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o644 })
  }
}
