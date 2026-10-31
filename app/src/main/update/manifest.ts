import { createHash, createPublicKey, verify } from 'node:crypto'

export const SKILL_API = 1
export const MAX_FILES = 600
export const MAX_BYTES = 80 * 1024 * 1024
export const ASSET_PREFIX = 'https://github.com/knuaf-devcat/knuaf-dev/releases/download/'
export const CHANNEL_URL = 'https://raw.githubusercontent.com/knuaf-devcat/knuaf-dev/main/updates/channel.json'
export interface Envelope { manifest: string; sig: string }
export interface SkillManifest {
  schema: 1; name: 'knuaf-dev'; version: string; api: number; minApp: string
  url: string; size: number; sha256: string; files: Record<string, string>
}
export interface VerifiedSkill { manifest: SkillManifest; digest: string; envelope: Envelope }
export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('업데이트 정보 형식이 잘못됐어요.')
  return value as Record<string, unknown>
}
export function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new Error('업데이트 정보 항목이 잘못됐어요.')
}
export function version(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) || value.split('.').some(n => !Number.isSafeInteger(Number(n)))) throw new Error('판 번호가 잘못됐어요.')
}
export function compare(a: string, b: string): number {
  version(a); version(b)
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1
  return 0
}
export function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('파일 확인값이 잘못됐어요.')
}
export function safePath(value: string): void {
  if (!value || value !== value.normalize('NFC') || value.includes('\\') || /[\x00-\x1f\x7f:]/.test(value)) throw new Error('안전하지 않은 파일 경로예요.')
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error('안전하지 않은 파일 경로예요.')
  }
}
export function assetUrl(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.startsWith(ASSET_PREFIX)) throw new Error('허용되지 않은 내려받기 주소예요.')
  const u = new URL(value)
  if (u.username || u.password || u.search || u.hash || u.href !== value || !u.pathname.startsWith('/knuaf-devcat/knuaf-dev/releases/download/')) throw new Error('허용되지 않은 내려받기 주소예요.')
}
function base64(value: unknown, max: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('서명 정보 인코딩이 잘못됐어요.')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error('서명 정보 인코딩이 잘못됐어요.')
  return bytes
}
/** Decode only after Ed25519 verification of the original bytes, shared by both payloads. */
export function signedObject(value: unknown, keys: readonly string[]): { value: Record<string, unknown>; digest: string; envelope: Envelope } {
  const e = object(value)
  const bytes = base64(e.manifest, 256 * 1024), sig = base64(e.sig, 64)
  if (sig.length !== 64 || !keys.some(key => {
    try { const pk = createPublicKey(key); return pk.asymmetricKeyType === 'ed25519' && verify(null, bytes, pk, sig) } catch { return false }
  })) throw new Error('업데이트 서명을 확인하지 못했어요.')
  return {
    value: object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))),
    digest: sha256(bytes), envelope: { manifest: String(e.manifest), sig: String(e.sig) }
  }
}
export function verifySkill(value: unknown, keys: readonly string[]): VerifiedSkill {
  const e = object(value), signed = signedObject(value, keys), m = signed.value
  exact(m, ['schema', 'name', 'version', 'api', 'minApp', 'url', 'size', 'sha256', 'files'])
  if (m.schema !== 1 || m.name !== 'knuaf-dev' || !Number.isSafeInteger(m.api) || Number(m.api) < 1 || !Number.isSafeInteger(m.size) || Number(m.size) < 1 || Number(m.size) > MAX_BYTES) throw new Error('규칙집 정보가 잘못됐어요.')
  version(m.version); version(m.minApp); assetUrl(m.url); hash(m.sha256)
  const files = object(m.files), names = Object.keys(files)
  if (names.length > MAX_FILES || !Object.hasOwn(files, 'skill.json') || !Object.hasOwn(files, 'SKILL.md')) throw new Error('규칙집 파일 목록이 잘못됐어요.')
  const aliases = new Set<string>()
  for (const name of names) {
    safePath(name); hash(files[name])
    const alias = name.toLowerCase()
    if (aliases.has(alias)) throw new Error('겹치는 파일 경로예요.')
    aliases.add(alias)
  }
  for (const name of names) for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) if (aliases.has(name.slice(0, i).toLowerCase())) throw new Error('파일과 폴더 경로가 겹쳐요.')
  for (const key of ['version', 'api', 'minApp', 'url']) if (Object.hasOwn(e, key) && e[key] !== m[key]) throw new Error('채널 정보와 서명된 정보가 달라요.')
  return { manifest: m as unknown as SkillManifest, digest: signed.digest, envelope: signed.envelope }
}
export function compatible(m: SkillManifest, appVersion: string): boolean { return m.api === SKILL_API && compare(m.minApp, appVersion) <= 0 }
