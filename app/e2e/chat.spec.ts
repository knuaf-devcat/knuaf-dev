// Unit tests for src/main/chat/service.ts with an injected fake AgentConnection.
// Plain Playwright `test()` in Node: no Electron and no real agent processes.
import { expect, test } from '@playwright/test'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { skillSource, VERSION_FILE } from '../src/main/agent'
import type { AgentConnection } from '../src/main/chat/contracts'

const appRoot = resolve(__dirname, '..')
const source = skillSource(appRoot, false, '/nonexistent')

function fake(over: Partial<AgentConnection> = {}): AgentConnection {
  return {
    status: async () => ({ installed: true, connected: true, version: '0.0.0-test', detail: 'fake' }),
    login: async () => {},
    run: async () => {},
    respond: () => {},
    stop: async () => {},
    ...over
  }
}

function service(conn: AgentConnection, over: { sidecarBusy?: (root: string) => boolean } = {}) {
  return new ChatService({
    skillSource: source,
    userData: mkdtempSync(join(tmpdir(), 'kd-ud-')),
    emit: () => {},
    openExternal: async () => {},
    connectionFactory: () => conn,
    ...over
  })
}

async function settled(svc: ChatService, root: string) {
  for (let i = 0; i < 200; i++) {
    const s = svc.snapshot(root, 'codex')
    if (s.state !== 'running' && s.state !== 'permission') return s
    await new Promise((r) => setTimeout(r, 10))
  }
  return svc.snapshot(root, 'codex')
}

test('sending the same requestId twice keeps a single message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-chat-'))
  const svc = service(fake())
  await svc.send(root, 'codex', '안녕하세요', 'req-1')
  const again = await svc.send(root, 'codex', '안녕하세요', 'req-1')
  expect(again.messages.filter((m) => m.id === 'req-1')).toHaveLength(1)
  const s = await settled(svc, root)
  expect(s.messages).toHaveLength(1)
  expect(s.messages[0].delivery).toBe('sent')
  await svc.close()
})

test('a failing run marks the message uncertain and the snapshot error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-chat-'))
  const svc = service(fake({ run: async () => { throw new Error('연결 종료') } }))
  await svc.send(root, 'codex', '질문', 'req-2')
  const s = await settled(svc, root)
  expect(s.state).toBe('error')
  expect(s.error).toContain('연결 종료')
  expect(s.messages[0].delivery).toBe('uncertain')
  await svc.close()
})

test('a persisted running snapshot restores as interrupted with uncertain delivery', () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-chat-'))
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  const file = join(root, '.knuaf-gui', 'chat-codex.json')
  writeFileSync(file, JSON.stringify({
    root, provider: 'codex', state: 'running', sessionId: 'th-1',
    messages: [{ id: 'm1', role: 'user', text: '답변', at: new Date().toISOString(), delivery: 'pending' }]
  }), 'utf-8')
  const s = service(fake()).snapshot(root, 'codex')
  expect(s.state).toBe('interrupted')
  expect(s.error).toBeTruthy()
  expect(s.messages[0].delivery).toBe('uncertain')
  // recovery is written back at once: the file on disk matches what the renderer saw
  const persisted = JSON.parse(readFileSync(file, 'utf-8'))
  expect(persisted.state).toBe('interrupted')
  expect(persisted.messages[0].delivery).toBe('uncertain')
})

test('an outdated project skill copy is reinstalled with a system notice and a backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-chat-'))
  const svc = service(fake())
  await svc.send(root, 'codex', '첫 답변', 'req-4')
  const ok = await settled(svc, root)
  expect(ok.messages).toHaveLength(1)
  expect(ok.skillHash).toBeTruthy()

  writeFileSync(join(root, '.agents', 'skills', 'knuaf-doc', VERSION_FILE), 'tampered\n', 'utf-8')
  await svc.send(root, 'codex', '다음 답변', 'req-5')
  const s = await settled(svc, root)
  // prior messages preserved: 2 user messages + exactly 1 system notice
  expect(s.messages.filter((m) => m.role === 'user')).toHaveLength(2)
  const notice = s.messages.filter((m) => m.role === 'system')
  expect(notice).toHaveLength(1)
  expect(notice[0].text).toContain('규칙집이 갱신됐어요')
  // the copy was reinstalled to the current version and the old one backed up
  expect(readFileSync(join(root, '.agents', 'skills', 'knuaf-doc', VERSION_FILE), 'utf-8').trim()).toBe(s.skillHash)
  expect(readdirSync(join(root, '.agents', 'skills')).some((n) => n.startsWith('knuaf-doc.bak-'))).toBe(true)
  await svc.close()
})

test('a sidecar write in progress rejects send without touching messages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-chat-'))
  const svc = service(fake(), { sidecarBusy: () => true })
  await expect(svc.send(root, 'codex', '답변', 'req-6')).rejects.toThrow('앱이 저장·검사 작업 중이에요')
  expect(svc.snapshot(root, 'codex').messages).toHaveLength(0)
  await svc.close()
})
