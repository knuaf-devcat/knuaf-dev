import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readRecoverable, writeFileAtomic } from '../safeWrite'
import { compatible, compare, exact, hash, MAX_BYTES, MAX_FILES, object, sha256, SKILL_API, verifySkill, version, type VerifiedSkill } from './manifest'
import { extractSkill } from './archive'
export interface Highest { version: string; manifest: string }
export interface SkillState { active: string | null; kept: Record<string, string>; highest: Highest | null }
const empty = (): SkillState => ({ active: null, kept: {}, highest: null })
function highest(v: unknown): Highest {
  const h = object(v); exact(h, ['version', 'manifest']); version(h.version); hash(h.manifest)
  return h as unknown as Highest
}
function parseState(text: string): SkillState {
  const s = object(JSON.parse(text)); exact(s, ['active', 'kept', 'highest'])
  if (s.active !== null) version(s.active)
  const kept = object(s.kept)
  for (const [v, digest] of Object.entries(kept)) { version(v); hash(digest) }
  if (s.active !== null && !Object.hasOwn(kept, String(s.active))) throw new Error('보관판 상태가 잘못됐어요.')
  if (s.highest !== null) highest(s.highest)
  return s as unknown as SkillState
}
function persist(file: string, value: unknown, complete: (text: string) => unknown): void {
  const result = writeFileAtomic(file, JSON.stringify(value), { mode: 0o600, complete: text => { try { complete(text); return true } catch { return false } } })
  if (!result.ok) throw result.error
}
export class SkillStore {
  readonly root: string
  readonly bundledVersion: string
  constructor(userData: string, readonly bundled: string, readonly appVersion: string, readonly keys: readonly string[]) {
    this.root = join(userData, 'skill-store')
    // Pre-compose checkout is the design's initial trusted bundled S0 (1.0.0).
    if (!existsSync(join(bundled, 'skill.json'))) this.bundledVersion = '1.0.0'
    else {
      const m = object(JSON.parse(readFileSync(join(bundled, 'skill.json'), 'utf8')))
      version(m.version)
      if (m.api !== SKILL_API) throw new Error('동봉 규칙집 약속의 판이 맞지 않아요.')
      this.bundledVersion = m.version
    }
    mkdirSync(join(this.root, 'proofs'), { recursive: true })
  }
  state(): SkillState {
    let s = empty()
    try { s = readRecoverable(join(this.root, 'state.json'), parseState)?.value ?? s } catch { /* Corrupt active state falls back to bundle; independent high-water survives. */ }
    let backup: Highest | undefined
    try {
      backup = readRecoverable(join(this.root, 'highest.json'), text => highest(JSON.parse(text)))?.value
    } catch (error) {
      // A malformed backup must not erase a valid state high-water mark.
      if (!s.highest && existsSync(join(this.root, 'highest.json'))) throw error
    }
    if (backup && (!s.highest || compare(backup.version, s.highest.version) > 0)) s.highest = backup
    else if (backup && s.highest && backup.version === s.highest.version && backup.manifest !== s.highest.manifest) throw new Error('같은 판의 확인값이 달라요.')
    return s
  }
  private write(s: SkillState): void {
    persist(join(this.root, 'state.json'), s, parseState)
    if (s.highest) persist(join(this.root, 'highest.json'), s.highest, text => highest(JSON.parse(text)))
  }
  proof(v: string, digest: string): VerifiedSkill {
    version(v)
    const proof = verifySkill(JSON.parse(readFileSync(join(this.root, 'proofs', `${v}.json`), 'utf8')), this.keys)
    if (proof.manifest.version !== v || proof.digest !== digest || !compatible(proof.manifest, this.appVersion)) throw new Error('보관판 정보가 맞지 않아요.')
    return proof
  }
  valid(v: string, digest: string): boolean {
    try {
      const { manifest } = this.proof(v, digest), base = join(this.root, v)
      if (!lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink()) return false
      let count = 0, total = 0
      const seen = new Set<string>()
      const walk = (dir: string, prefix: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const name = prefix + e.name, path = join(dir, e.name), st = lstatSync(path)
          if (st.isSymbolicLink()) throw new Error('link')
          if (st.isDirectory()) { walk(path, name + '/'); continue }
          if (!st.isFile() || !Object.hasOwn(manifest.files, name) || ++count > MAX_FILES || (total += st.size) > MAX_BYTES || sha256(readFileSync(path)) !== manifest.files[name]) throw new Error('file')
          seen.add(name)
        }
      }
      walk(base, '')
      if (seen.size !== Object.keys(manifest.files).length) return false
      const m = JSON.parse(readFileSync(join(base, 'skill.json'), 'utf8'))
      return m.version === manifest.version && m.api === manifest.api
    } catch { return false }
  }
  resolveSkillSource(): string {
    try {
      const s = this.state(), v = s.active
      if (v && compare(v, this.bundledVersion) >= 0 && this.valid(v, s.kept[v])) return join(this.root, v)
    } catch { /* Unusable store never prevents trusted bundled operation. */ }
    return this.bundled
  }
  disposition(p: VerifiedSkill): 'new' | 'repair' | 'kept' {
    const m = p.manifest, s = this.state()
    if (!compatible(m, this.appVersion)) throw new Error('이 규칙집은 앱 새 판이 필요해요.')
    const floor = [this.bundledVersion, s.active, s.highest?.version].filter((v): v is string => !!v).sort(compare).at(-1)!
    if (compare(m.version, floor) > 0) return 'new'
    if (s.highest?.version === m.version && s.highest.manifest === p.digest && compare(m.version, this.bundledVersion) >= 0) return s.kept[m.version] === p.digest && this.valid(m.version, p.digest) ? 'kept' : 'repair'
    throw new Error('이전 판이거나 같은 판의 내용이 달라서 받지 않아요.')
  }
  publish(p: VerifiedSkill, zip: Buffer): void {
    this.disposition(p)
    const temp = mkdtempSync(join(this.root, '.stage-')), v = p.manifest.version
    try {
      extractSkill(zip, temp, p.manifest)
      persist(join(this.root, 'proofs', `${v}.json`), p.envelope, text => verifySkill(JSON.parse(text), this.keys))
      const destination = join(this.root, v)
      // Repairs replace only a verified-version store folder; never an arbitrary path.
      if (existsSync(destination)) {
        if (this.state().active === v && this.valid(v, p.digest)) throw new Error('사용 중인 정상 보관판은 바꾸지 않아요.')
        const quarantine = join(this.root, `.damaged-${v}-${Date.now()}`)
        renameSync(destination, quarantine)
      }
      renameSync(temp, destination)
      const s = this.state()
      s.kept[v] = p.digest
      s.highest = { version: v, manifest: p.digest }
      this.write(s)
    } finally { rmSync(temp, { recursive: true, force: true }) }
  }
  select(v: string | null): string | null {
    const s = this.state(), previous = s.active
    if (v !== null) {
      version(v)
      if (compare(v, this.bundledVersion) < 0 || !Object.hasOwn(s.kept, v) || !this.valid(v, s.kept[v])) throw new Error('이 보관판은 사용할 수 없어요.')
    }
    s.active = v
    this.write(s)
    return previous
  }
  rollbackTarget(): string | null {
    const s = this.state(), current = this.resolveSkillSource() === this.bundled ? this.bundledVersion : s.active!
    return Object.keys(s.kept).filter(v => compare(v, current) < 0 && compare(v, this.bundledVersion) >= 0 && this.valid(v, s.kept[v])).sort(compare).at(-1) ?? null
  }
  /** Startup only, before any user request can hold an old source. */
  cleanup(): void {
    const s = this.state(), versions = Object.keys(s.kept).sort(compare).reverse()
    const retain = new Set([...new Set([s.active, s.highest?.version, ...versions].filter((v): v is string => !!v))].slice(0, 2))
    for (const v of versions) if (!retain.has(v)) {
      rmSync(join(this.root, v), { recursive: true, force: true })
      rmSync(join(this.root, 'proofs', `${v}.json`), { force: true })
      delete s.kept[v]
    }
    this.write(s)
    for (const entry of readdirSync(this.root)) {
      if (/^\.(stage|download|damaged)-/.test(entry)) rmSync(join(this.root, entry), { recursive: true, force: true })
    }
  }
}
