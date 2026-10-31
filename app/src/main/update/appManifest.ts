import { assetUrl, compare, exact, hash, object, signedObject, version, type Envelope } from './manifest'
export const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024
export interface AppManifest { schema: 1; name: 'knuaf-dev-app'; version: string; platform: 'win32-x64'; url: string; size: number; sha256: string }
export interface VerifiedApp { manifest: AppManifest; envelope: Envelope }
export function releasePage(v: unknown): string { version(v); return `https://github.com/knuaf-devcat/knuaf-dev/releases/tag/v${v}` }
export function parseApp(value: unknown, keys: readonly string[]): VerifiedApp {
  const e = object(value), signed = signedObject(value, keys), m = signed.value
  exact(m, ['schema', 'name', 'version', 'platform', 'url', 'size', 'sha256'])
  if (m.schema !== 1 || m.name !== 'knuaf-dev-app' || m.platform !== 'win32-x64' || !Number.isSafeInteger(m.size) || Number(m.size) < 1 || Number(m.size) > MAX_INSTALLER_BYTES) throw new Error('앱 업데이트 정보가 잘못됐어요.')
  version(m.version); assetUrl(m.url); hash(m.sha256)
  if (!new URL(m.url).pathname.toLowerCase().endsWith('.exe')) throw new Error('Windows 설치 파일 주소가 잘못됐어요.')
  for (const key of ['version', 'platform', 'url', 'size', 'sha256']) if (Object.hasOwn(e, key) && e[key] !== m[key]) throw new Error('채널 정보와 서명된 앱 정보가 달라요.')
  return { manifest: m as unknown as AppManifest, envelope: signed.envelope }
}
export function verifyApp(value: unknown, keys: readonly string[], current: string): VerifiedApp {
  const proof = parseApp(value, keys)
  if (compare(proof.manifest.version, current) <= 0) throw new Error('현재 앱보다 새로운 판만 설치할 수 있어요.')
  return proof
}
