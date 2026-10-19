/**
 * 내려받기 한 번 — Electron 에 기대지 않는 순수 부분(runtime.ts 가 `net.fetch` 를 넘긴다).
 *
 * 왜 따로 두나: 쓰기 실패가 설치 요청을 영구 대기로 만들던 결함(PY-C1-02)을 **실제 소스로**
 * 시험하려면 스트림을 갈아 끼울 수 있어야 한다. electron 을 import 하지 않으므로 node 가
 * TypeScript 를 그대로 읽어 시험할 수 있다(e2e/runtime-download.spec.ts).
 */
import { createHash } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { Readable, Transform, type Writable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'

export interface DownloadFailure { code: string; message: string }

export interface DownloadProgress { phase: string; received?: number; total?: number }

export interface DownloadDeps {
  /** `net.fetch`(시스템 프록시·인증서 저장소를 타는 Chromium 망) 또는 시험용 가짜. */
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  /** 기본은 `createWriteStream(dest)`. 시험이 쓰기 오류를 주입할 때만 바꾼다. */
  createStream?: (dest: string) => Writable
}

const cancelled: DownloadFailure = { code: 'runtime_cancelled', message: '사용자가 취소함' }

/**
 * `url` 을 `dest` 로 스트리밍하며 SHA-256 과 받은 바이트를 센다.
 * 실패·취소·쓰기 오류는 모두 이 약속을 **끝낸다** — 호출자(설치 슬롯)가 풀리지 않으면
 * 취소·재시도가 앱 재시작 전까지 막힌다.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  expected: { sha256: string; size?: number },
  onEvent: (event: DownloadProgress) => void,
  signal: AbortSignal,
  deps: DownloadDeps
): Promise<void> {
  const res = await deps.fetch(url, { signal })
  if (!res.ok) throw { code: 'runtime_download_failed', message: `내려받기 실패 ${res.status} ${res.statusText}` } satisfies DownloadFailure
  if (!res.body) throw { code: 'runtime_download_failed', message: '응답 본문이 비어 있음' } satisfies DownloadFailure
  const header = Number(res.headers.get('content-length') ?? 0)
  const total = expected.size ?? (Number.isFinite(header) ? header : 0)
  const hash = createHash('sha256')
  let received = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk)
      received += chunk.byteLength
      onEvent({ phase: '내려받는 중', received, total })
      done(null, chunk)
    }
  })
  const sink: Writable = deps.createStream ? deps.createStream(dest) : (createWriteStream(dest) as WriteStream)
  try {
    // pipeline 이 쓰기 오류·스트림 종료·취소(signal)를 한 경로로 모은다 — `drain` 만 기다리던
    // 예전 루프는 실패한 스트림이 drain 을 보내지 않아 영원히 멈췄다(PY-C1-02).
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), counter, sink, { signal })
  } catch (error) {
    if (signal.aborted) throw cancelled
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && 'message' in error) {
      throw { code: 'runtime_download_failed', message: `${String(error.code)}: ${String(error.message)}` } satisfies DownloadFailure
    }
    throw { code: 'runtime_download_failed', message: error instanceof Error ? error.message : String(error) } satisfies DownloadFailure
  }
  if (signal.aborted) throw cancelled
  if (expected.size !== undefined && received !== expected.size) {
    throw { code: 'runtime_hash_mismatch', message: `크기 불일치: 기대 ${expected.size}바이트, 실제 ${received}바이트` } satisfies DownloadFailure
  }
  const digest = hash.digest('hex')
  if (digest !== expected.sha256) {
    throw { code: 'runtime_hash_mismatch', message: `sha256 불일치: 기대 ${expected.sha256}, 실제 ${digest}` } satisfies DownloadFailure
  }
}
