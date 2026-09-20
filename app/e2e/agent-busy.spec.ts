import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, openProject, plantStaleLock, synthProject } from './helpers'

// 도우미 채팅 실행 중에는 sidecar 쓰기가 거절된다 — 동시 쓰기는 도우미의 저장과 경합한다.
// 실행 중 상태는 핸드셰이크에 응답하지 않는 가짜 codex로 만든다 — send() 가 acquire 한
// 뒤 status() 에서 멈추는 동안 busy 가 잡힌다.
test('a running chat turn rejects sidecar writes with agent_busy, then recovers', async () => {
  const bindir = mkdtempSync(join(tmpdir(), 'kd-bin-'))
  writeFileSync(join(bindir, 'codex'), '#!/bin/sh\nsleep 300\n', { mode: 0o755 })
  const root = synthProject({ withContent: false })
  plantStaleLock(root) // gives lock.unlock something real to release on the second attempt
  const { electronApp, page } = await launch({ env: { PATH: `${bindir}:/usr/bin:/bin` } })
  try {
    await openProject(page, root)
    await page.getByRole('heading', { name: '내 논문' }).waitFor()

    // send() 는 가짜 서버의 initialize 응답을 영원히 기다린다 — 그동안 owner 를 쥔다.
    void page.evaluate((r) => window.knuaf.chat.send(r, 'codex', '홀드', crypto.randomUUID()), root).catch(() => {})
    await expect.poll(async () => {
      const r = await page.evaluate((r) => window.knuaf.call('lock.unlock', { root: r }), root)
      return 'error' in r ? r.error.code : 'no-error'
    }, { timeout: 15_000 }).toBe('agent_busy')

    // reads are never gated
    const read = await page.evaluate((r) => window.knuaf.call('project.status', { root: r }), root)
    expect('error' in read ? read.error : null).toBeNull()

    // 멈춘 연결을 끊으면 owner 가 풀리고 같은 쓰기가 sidecar 에 도달한다.
    // stop() 은 응답 없는 프로세스를 죽이고, 진행 중인 연결 재시도도 함께 끊는다.
    await page.evaluate((r) => window.knuaf.chat.stop(r, 'codex'), root)
    await expect.poll(async () => {
      const r = await page.evaluate((r) => window.knuaf.call('lock.unlock', { root: r }), root)
      return 'error' in r ? r.error.code : 'ok'
    }, { timeout: 15_000 }).toBe('ok')
  } finally {
    await electronApp.close()
  }
})
