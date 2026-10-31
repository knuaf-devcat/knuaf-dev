import { assetUrl, MAX_BYTES, object, verifySkill, type VerifiedSkill } from './manifest'
import type { UpdateConfig } from './keys'
export type Transport = (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => Promise<Response>
const CDN: Record<string, true> = { 'release-assets.githubusercontent.com': true, 'objects.githubusercontent.com': true, 'github-releases.githubusercontent.com': true }

/** Redirects are inspected before the next request, not just after fetching an arbitrary host. */
export async function boundedFetch(url: string, signal: AbortSignal, fetch: Transport, limit: number, config: UpdateConfig, channel = false): Promise<Response> {
  if (channel) { if (url !== config.channel) throw new Error('채널 주소가 달라요.') } else assetUrl(url)
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { signal, redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location || channel || redirects === 5) throw new Error('허용되지 않은 업데이트 이동 주소예요.')
      const next = new URL(location, url)
      if (next.protocol !== 'https:' || next.username || next.password || next.port || next.hash || !Object.hasOwn(CDN, next.hostname)) throw new Error('허용되지 않은 업데이트 이동 주소예요.')
      url = next.href
      continue
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('업데이트를 내려받지 못했어요.') }
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body.cancel(); throw new Error('업데이트 크기 상한을 넘었어요.') }
    let received = 0
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > limit) throw new Error('업데이트 크기 상한을 넘었어요.')
        controller.enqueue(chunk)
      }
    }))
    return new Response(body, { status: response.status, headers: response.headers })
  }
  throw new Error('업데이트 이동 횟수가 너무 많아요.')
}
export async function readChannelDocument(config: UpdateConfig, fetch: Transport, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!config.keys.length) throw new Error('업데이트를 확인할 수 없어요.')
  const response = await boundedFetch(config.channel, signal, fetch, 512 * 1024, config, true)
  const channel = object(JSON.parse(await response.text()))
  if (channel.schema !== 1) throw new Error('업데이트 채널 형식이 잘못됐어요.')
  return channel
}
export async function readChannel(config: UpdateConfig, fetch: Transport, signal: AbortSignal): Promise<VerifiedSkill> {
  const channel = await readChannelDocument(config, fetch, signal)
  return verifySkill(channel.skill, config.keys)
}
export const downloadLimit = (size: number): number => Math.min(MAX_BYTES, size)
