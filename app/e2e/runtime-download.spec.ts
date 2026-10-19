// PY-C1-02 회귀 시험 — 다운로드 쓰기 실패·취소가 설치 요청을 영구 대기로 만들지 않는다.
//
// 검토자의 재현과 같은 입력: 정상 본문 + **open 뒤 write 에서 실패하는** 스트림.
// 소스(`src/main/runtimeDownload.ts`)를 그대로 import 해서 돌린다.
import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { createHash } from 'node:crypto'
import { downloadToFile } from '../src/main/runtimeDownload'

const BODY = Buffer.from('fake runtime bytes '.repeat(64))
const SHA = createHash('sha256').update(BODY).digest('hex')

function response(body: Buffer, opts: { stallMs?: number } = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (opts.stallMs) await new Promise((r) => setTimeout(r, opts.stallMs))
      controller.enqueue(new Uint8Array(body))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-length': String(body.byteLength) } })
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: ${ms}ms 안에 끝나지 않음`)), ms))
  ])
}

test('open 뒤 쓰기 오류(ENOSPC)는 실패로 끝난다 — drain 을 기다리며 멈추지 않는다', async () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'kd-runtime-dl-')), 'x.tar.gz')
  const sink = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })))
    }
  })
  const run = downloadToFile('http://127.0.0.1/x', dest, { sha256: SHA, size: BODY.byteLength }, () => {},
    new AbortController().signal, { fetch: async () => response(BODY), createStream: () => sink })

  const failure = await within(run.then(() => null, (e: unknown) => e), 5_000, '쓰기 오류 다운로드')
  expect(failure, '쓰기 오류인데 성공으로 끝났다').not.toBeNull()
  expect(String((failure as { code?: string }).code)).toBe('runtime_download_failed')
  expect(String((failure as { message?: string }).message)).toContain('ENOSPC')
})

test('취소는 진행 중인 다운로드를 깨우고 runtime_cancelled 로 끝난다', async () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'kd-runtime-dl-')), 'x.tar.gz')
  const abort = new AbortController()
  const run = downloadToFile('http://127.0.0.1/x', dest, { sha256: SHA }, () => {}, abort.signal,
    { fetch: async () => response(BODY, { stallMs: 10_000 }) })
  setTimeout(() => abort.abort(), 50)
  const failure = await within(run.then(() => null, (e: unknown) => e), 5_000, '취소')
  expect((failure as { code?: string }).code).toBe('runtime_cancelled')
})

test('정상 본문은 해시·크기를 검증하고 파일로 남긴다', async () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'kd-runtime-dl-')), 'x.tar.gz')
  await downloadToFile('http://127.0.0.1/x', dest, { sha256: SHA, size: BODY.byteLength }, () => {},
    new AbortController().signal, { fetch: async () => response(BODY) })
  expect(readFileSync(dest).byteLength).toBe(BODY.byteLength)
})

test('해시가 다르면 runtime_hash_mismatch 로 실패한다', async () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'kd-runtime-dl-')), 'x.tar.gz')
  const failure = await downloadToFile('http://127.0.0.1/x', dest, { sha256: '0'.repeat(64) }, () => {},
    new AbortController().signal, { fetch: async () => response(BODY) }).then(() => null, (e: unknown) => e)
  expect((failure as { code?: string }).code).toBe('runtime_hash_mismatch')
})
