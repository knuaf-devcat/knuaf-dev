import { createPublicKey } from 'node:crypto'
import { CHANNEL_URL } from './manifest'

// Owner-approved release prerequisite: populate both only after key provisioning.
export const UPDATE_KEYS = { current: '', reserve: '' } as const
export interface UpdateConfig { channel: string; keys: readonly string[]; development: boolean }
function valid(key: string): boolean { try { return createPublicKey(key).asymmetricKeyType === 'ed25519' } catch { return false } }
export function updateConfig(packaged: boolean, env: NodeJS.ProcessEnv = process.env): UpdateConfig {
  const development = !packaged
  if (development && env.KNUAF_UPDATE_PUBLIC_KEY) {
    const key = env.KNUAF_UPDATE_PUBLIC_KEY
    const channel = env.KNUAF_UPDATE_CHANNEL_URL || CHANNEL_URL
    const u = new URL(channel)
    if (!valid(key) || (channel !== CHANNEL_URL && !(u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) && !u.username && !u.password))) throw new Error('개발용 업데이트 설정이 잘못됐어요.')
    return { channel, keys: [key], development }
  }
  const keys = Object.values(UPDATE_KEYS)
  return { channel: CHANNEL_URL, keys: keys.every(valid) ? keys : [], development }
}
