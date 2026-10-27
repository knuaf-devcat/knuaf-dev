// 모델 칩의 **뒷단**(ChatGPT 먼저) — 같은 회사 모델을 골라 같은 대화에서 이어 가는 통로.
// 실제 AI 로그인·실제 turn/start·실제 계정 model/list 는 쓰지 않는다. 가짜 app-server 만 쓴다.
import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { CodexConnection } from '../src/main/chat/codex'
import { skillSource } from '../src/main/agent'
import { useChat } from '../src/renderer/src/store/chat'
import {
  CODEX_TIER_MODELS, codexRecommendations, effectiveModelChoice,
  type ChatModelInfo, type ModelChoice
} from '../src/shared/chat'
import type { AgentConnection, AgentEvents, AgentOptions } from '../src/main/chat/contracts'
import { fakeCodexEnv } from './fixtures/fake-codex'

const appRoot = resolve(__dirname, '..')
const source = skillSource(appRoot, false, '/nonexistent')

function model(over: Partial<ChatModelInfo> & { model: string; name: string }): ChatModelInfo {
  return { description: '', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', isDefault: false, ...over }
}

/** 형님 확정표의 별칭 네 개가 계정 목록에 다 있는 경우. */
const FOUR = [model({ model: 'gpt-sol', name: 'Sol' }), model({ model: 'gpt-terra', name: 'Terra' }), model({ model: 'gpt-luna', name: 'Luna' }), model({ model: 'gpt-astra', name: 'Astra' })]

test('추천은 형님 표 그대로 — Sol·Astra 가 보이면 높음 줄', () => {
  const rec = codexRecommendations(FOUR)
  expect(rec.tier).toBe('high')
  expect(rec.lanes).toEqual([
    { lane: 'design', label: '설계', model: 'gpt-sol' },
    { lane: 'research', label: '자료 찾기', model: 'gpt-astra' },
    { lane: 'writing', label: '글쓰기', model: 'gpt-terra' },
    { lane: 'repeat', label: '반복 작업', model: 'gpt-luna' },
    { lane: 'review', label: '검토(새 대화)', model: 'gpt-astra' }
  ])
  // 용도 한 줄은 표에서 나온다 — Sol 은 설계, Terra 는 글쓰기.
  expect(rec.byModel['gpt-sol'].purpose).toBe('설계')
  expect(rec.byModel['gpt-terra'].purpose).toBe('글쓰기')
  expect(rec.byModel['gpt-astra'].purpose).toBe('자료 찾기 · 검토(새 대화)')
})

test('높음 줄 모델이 없으면 낮음 줄로 내려가고, 목록에 없는 모델은 추천에서 빠진다', () => {
  const terraLuna = [model({ model: 'gpt-terra', name: 'Terra' }), model({ model: 'gpt-luna', name: 'Luna' })]
  const low = codexRecommendations(terraLuna)
  expect(low.tier).toBe('low')
  expect(low.lanes.map((l) => [l.lane, l.model])).toEqual([
    ['design', 'gpt-terra'], ['research', 'gpt-luna'], ['writing', 'gpt-luna'], ['repeat', 'gpt-luna'], ['review', 'gpt-terra']
  ])
  // Luna 만 있는 요금제: Luna 가 추천되는 칸만 남는다.
  const lunaOnly = codexRecommendations([model({ model: 'gpt-luna', name: 'Luna' })])
  expect(lunaOnly.lanes.every((l) => l.model === 'gpt-luna')).toBe(true)
  expect(lunaOnly.lanes).toHaveLength(3)
  // 별칭은 model·name 어디에 있어도 찾는다(요금제별 실제 id 는 아직 미확인).
  expect(codexRecommendations([model({ model: 'gpt-5.1', name: 'GPT Sol (높음)' })]).tier).toBe('high')
  // 표에 없는 모델은 어떤 칸에도 붙지 않는다.
  const stray = codexRecommendations([model({ model: 'gpt-nova', name: 'Nova' })])
  expect(stray.lanes).toEqual([])
  expect(stray.byModel).toEqual({})
  expect(CODEX_TIER_MODELS.high.review).toBe('astra')
})

test('고른 값은 이 계정 목록에 비춰 정규화된다 (없는 모델=안 골름, 미지원 깊이=버림)', () => {
  expect(effectiveModelChoice(null, FOUR)).toBeNull()
  // 목록을 아직 못 받았으면 선택을 그대로 둔다 — 목록 실패가 선택을 지우면 안 된다.
  expect(effectiveModelChoice({ model: 'gpt-sol', effort: 'high' }, null)).toEqual({ model: 'gpt-sol', effort: 'high' })
  // 요금제가 바뀌어 그 모델이 사라졌다 → 안 골름(다음 전송이 실패하지 않는다).
  expect(effectiveModelChoice({ model: 'gpt-gone', effort: null }, FOUR)).toBeNull()
  // 그 모델이 지원하지 않는 깊이는 버리고 모델 선택은 살린다.
  const luna = [model({ model: 'gpt-luna', name: 'Luna', efforts: ['low'] })]
  expect(effectiveModelChoice({ model: 'gpt-luna', effort: 'high' }, luna)).toEqual({ model: 'gpt-luna', effort: null })
})

const noopEvents: AgentEvents = { message: () => {}, permission: () => {}, note: () => {}, session: () => {}, skill: () => {} }

/** 가짜 app-server 하나를 띄울 수 있는 시험 환경 — 셔뱅 shim 은 fakeCodexEnv 가 만든다. */
function codexSandbox(extra: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'kd-model-bin-'))
  const paths = {
    log: join(dir, 'turns.jsonl'),
    applied: join(dir, 'applied.jsonl'),
    state: join(dir, 'state'),
    threads: join(dir, 'threads.json')
  }
  writeFileSync(paths.log, '')
  writeFileSync(paths.applied, '')
  writeFileSync(paths.state, 'chatgpt\n')
  const root = mkdtempSync(join(tmpdir(), 'kd-model-root-'))
  const connect = (choiceOf: () => ModelChoice | null) => new CodexConnection({
    binary: join(dir, 'codex'), root, skill: join(root, '.agents', 'skills', 'knuaf-dev'),
    env: {
      ...process.env,
      ...fakeCodexEnv(dir, {
        FAKE_CODEX_STATE: paths.state, FAKE_CODEX_TURN_LOG: paths.log,
        FAKE_CODEX_APPLIED_LOG: paths.applied, FAKE_CODEX_THREAD_STATE: paths.threads, ...extra
      })
    },
    openExternal: async () => {}, modelChoice: choiceOf
  })
  return { paths, root, connect }
}

function readJsonLines(file: string): Record<string, unknown>[] {
  const text = readFileSync(file, 'utf-8').trim()
  return text ? text.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []
}

async function withCodex(
  extra: Record<string, string>,
  body: (conn: CodexConnection, ctx: { log: string; applied: string; root: string; setChoice: (c: ModelChoice | null) => void }) => Promise<void>
): Promise<void> {
  const box = codexSandbox(extra)
  let choice: ModelChoice | null = null
  const conn = box.connect(() => choice)
  try {
    await body(conn, { log: box.paths.log, applied: box.paths.applied, root: box.root, setChoice: (c) => { choice = c } })
  } finally {
    await conn.stop()
  }
}

test('고른 모델·생각 깊이가 turn/start 에 실리고, 안 고르면 키 자체가 없다', async () => {
  await withCodex({}, async (conn, { log, setChoice }) => {
    await conn.run('첫 메시지', undefined, noopEvents)
    setChoice({ model: 'gpt-sol', effort: 'high' })
    await conn.run('두 번째 메시지', undefined, noopEvents)
    const lines = readFileSync(log, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    // 안 고른 상태 = 지금까지와 같은 요청. 키가 "있는데 null" 도 아니다.
    expect(lines[0]).toEqual({})
    expect(lines[1]).toEqual({ model: 'gpt-sol', effort: 'high' })
  })
})

test('같은 대화에서 선택 → 해제 → 다른 모델/기본 깊이가 서버에 실제로 적용된다 (MC1-01)', async () => {
  await withCodex({ FAKE_CODEX_DEFAULT_MODEL: 'gpt-default', FAKE_CODEX_DEFAULT_EFFORT: 'medium' }, async (conn, { log, applied, setChoice }) => {
    let session: string | undefined
    const events: AgentEvents = { ...noopEvents, session: (id) => { session = id } }
    await conn.run('처음', undefined, events)
    setChoice({ model: 'gpt-sol', effort: 'high' })
    await conn.run('Sol 로', session, events)
    setChoice(null)
    await conn.run('해제', session, events)
    setChoice({ model: 'gpt-terra', effort: null })
    await conn.run('Terra 기본 깊이', session, events)

    // 서버 계약: 보낸 model·effort 는 같은 대화의 뒤 턴에도 남고, 생략은 "유지"다.
    // 그래서 해제는 키를 빼는 것이 아니라 서버 기본값을 **명시적으로** 보내야 한다.
    expect(readJsonLines(log)).toEqual([
      {},
      { model: 'gpt-sol', effort: 'high' },
      { model: 'gpt-default', effort: 'medium' },
      { model: 'gpt-terra', effort: 'low' }
    ])
    // 대역 서버가 실제로 들고 있는 값 — 마지막 두 줄이 기본값/Terra 로 돌아왔다는 증거.
    expect(readJsonLines(applied)).toEqual([
      { model: 'gpt-default', effort: 'medium' },
      { model: 'gpt-sol', effort: 'high' },
      { model: 'gpt-default', effort: 'medium' },
      { model: 'gpt-terra', effort: 'low' }
    ])
  })
})

test('앱을 다시 켠 뒤 재개한 대화가 기본값과 다르면 선택 없음도 기본값으로 되돌린다 (MC1-01)', async () => {
  const box = codexSandbox({ FAKE_CODEX_DEFAULT_MODEL: 'gpt-default', FAKE_CODEX_DEFAULT_EFFORT: 'medium' })
  let session: string | undefined
  const events: AgentEvents = { ...noopEvents, session: (id) => { session = id } }
  // 1세션: Sol/high 로 한 턴. 대화 상태는 파일에 남는다.
  let choice: ModelChoice | null = { model: 'gpt-sol', effort: 'high' }
  const first = box.connect(() => choice)
  try { await first.run('Sol 로', undefined, events) } finally { await first.stop() }
  // 2세션: 앱이 다시 켜졌고 저장된 선택이 없다. 같은 대화를 재개한다.
  choice = null
  const second = box.connect(() => choice)
  try { await second.run('이어서', session, events) } finally { await second.stop() }
  const applied = readJsonLines(box.paths.applied)
  expect(applied).toEqual([
    { model: 'gpt-sol', effort: 'high' },
    { model: 'gpt-default', effort: 'medium' }
  ])
})

test('초기화가 끝나기 전에 상태·목록을 동시에 물어도 둘 다 성공한다 (MC1-02)', async () => {
  await withCodex({ FAKE_CODEX_INIT_DELAY_MS: '50' }, async (conn) => {
    // 대역 서버는 initialize 전 요청을 `Not initialized` 로 거절한다(문서의 초기화 계약).
    const [status, models] = await Promise.allSettled([conn.status(), conn.models()])
    expect(status.status).toBe('fulfilled')
    expect(models.status).toBe('fulfilled')
    if (models.status === 'fulfilled') expect(models.value).toHaveLength(4)
  })
})

test('model/list 를 읽어 화면이 쓸 모양으로 옮기고, 숨긴 모델은 뺀다', async () => {
  const hidden = [
    { id: 'gpt-sol', model: 'gpt-sol', displayName: 'Sol', hidden: false, isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }] },
    { id: 'gpt-internal', model: 'gpt-internal', displayName: 'Internal', hidden: true, supportedReasoningEfforts: [] },
    { id: 'gpt-luna', model: 'gpt-luna', displayName: 'Luna', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }] }
  ]
  await withCodex({ FAKE_CODEX_MODELS: JSON.stringify(hidden) }, async (conn) => {
    expect(await conn.models()).toEqual([
      { model: 'gpt-sol', name: 'Sol', description: '', efforts: ['high'], defaultEffort: 'high', isDefault: true },
      { model: 'gpt-luna', name: 'Luna', description: '', efforts: ['low'], defaultEffort: null, isDefault: false }
    ])
  })
})

/** ChatService 를 가짜 연결로 — 연결이 받은 options 를 모아 두고 선택 해석을 직접 본다. */
function serviceWith(
  list: { current: ChatModelInfo[] },
  stored: { current: ModelChoice | null },
  over: { models?: () => Promise<ChatModelInfo[]>; store?: (choice: ModelChoice | null) => void } = {}
) {
  const seen: AgentOptions[] = []
  const conn: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: '0.0.0-test', detail: '' }),
    login: async () => {},
    run: async () => {},
    respond: () => {},
    stop: async () => {},
    models: over.models ?? (async () => list.current)
  }
  const svc = new ChatService({
    skillSource: source,
    userData: mkdtempSync(join(tmpdir(), 'kd-model-ud-')),
    emit: () => {},
    openExternal: async () => {},
    connectionFactory: (_provider, options) => { seen.push(options); return conn },
    modelChoice: () => stored.current,
    storeModelChoice: (_provider, choice) => { stored.current = choice; over.store?.(choice) }
  })
  return { svc, seen }
}

test('main 쪽: 목록으로 검증해 저장하고, 전송할 때 그 값이 연결에 닿는다', async () => {
  const list = { current: FOUR }
  const stored: { current: ModelChoice | null } = { current: null }
  const { svc, seen } = serviceWith(list, stored)
  const root = mkdtempSync(join(tmpdir(), 'kd-model-project-'))

  // 아직 안 골랐다 — 지금과 같은 기본값.
  const before = await svc.models(root, 'codex')
  expect(before).toMatchObject({ supported: true, selected: null })
  expect(before.models.map((m) => m.model)).toEqual(['gpt-sol', 'gpt-terra', 'gpt-luna', 'gpt-astra'])

  await expect(svc.setModel(root, 'codex', { model: 'gpt-gone', effort: null })).rejects.toThrow('이 계정에서 쓸 수 없는 모델이에요')
  await expect(svc.setModel(root, 'codex', { model: 'gpt-sol', effort: 'xhigh' })).rejects.toThrow('이 모델은 그 생각 깊이를 지원하지 않아요')
  stored.current = await svc.setModel(root, 'codex', { model: 'gpt-sol', effort: 'high' })
  expect(stored.current).toEqual({ model: 'gpt-sol', effort: 'high' })
  expect((await svc.models(root, 'codex')).selected).toEqual({ model: 'gpt-sol', effort: 'high' })

  await svc.send(root, 'codex', '안녕하세요', 'req-model-1')
  const options = seen[0]
  expect(options.modelChoice?.()).toEqual({ model: 'gpt-sol', effort: 'high' })

  // 요금제가 바뀌어 그 모델이 목록에서 사라지면 보내지 않는다 — 모든 전송이 실패하는 것보다 낫다.
  list.current = FOUR.filter((m) => m.model !== 'gpt-sol')
  expect((await svc.models(root, 'codex')).selected).toBeNull()
  await svc.send(root, 'codex', '다음 질문', 'req-model-2')
  expect(seen[0].modelChoice?.()).toBeNull()
})

test('느린 선택 검증이 나중의 선택 해제를 되살리지 않는다 (MC1-03 main)', async () => {
  const list = { current: FOUR }
  const stored: { current: ModelChoice | null } = { current: null }
  const writes: (ModelChoice | null)[] = []
  let release!: (value: ChatModelInfo[]) => void
  const pending = new Promise<ChatModelInfo[]>((resolve) => { release = resolve })
  const { svc } = serviceWith(list, stored, {
    models: () => pending,
    store: (choice) => { writes.push(choice) }
  })
  const root = mkdtempSync(join(tmpdir(), 'kd-model-project-'))

  // 1) Sol 선택 검증이 목록 응답을 기다린다. 2) 그 사이 학생이 해제한다.
  const slow = svc.setModel(root, 'codex', { model: 'gpt-sol', effort: 'high' })
  expect(await svc.setModel(root, 'codex', null)).toBeNull()
  expect(stored.current).toBeNull()
  // 3) 이제야 첫 목록이 도착한다 — 해제를 되살리면 안 된다.
  release(FOUR)
  expect(await slow).toBeNull()
  expect(stored.current).toBeNull()
  expect(writes).toEqual([null])
})

test('늦게 끝난 목록 응답이 새 선택을 되돌리지 않는다 (MC1-03 화면)', async () => {
  let release!: (value: unknown) => void
  const pendingModels = new Promise((resolve) => { release = resolve })
  ;(globalThis as unknown as { window: unknown }).window = {
    knuaf: {
      chat: {
        models: () => pendingModels,
        setModel: async () => ({ result: { model: 'gpt-terra', effort: null } })
      }
    }
  }
  useChat.setState({
    root: '/p/model-order', provider: 'codex', visit: 0, error: null,
    models: null, modelsSupported: true, modelsError: null, modelChoice: null, modelSeq: 0
  })
  const loading = useChat.getState().loadModels()
  expect(await useChat.getState().chooseModel({ model: 'gpt-terra', effort: null })).toBe(true)
  expect(useChat.getState().modelChoice).toEqual({ model: 'gpt-terra', effort: null })
  // 예전 목록 응답(selected=Sol)이 늦게 도착 — 목록은 반영해도 선택은 되돌리지 않는다.
  release({ result: { provider: 'codex', supported: true, models: [], selected: { model: 'gpt-sol', effort: 'high' } } })
  await loading
  expect(useChat.getState().modelChoice).toEqual({ model: 'gpt-terra', effort: null })
  expect(useChat.getState().models).toEqual([])
})

test('모델 목록 통로가 없는 공급자(이번 판의 Claude)는 supported:false 로 답한다', async () => {
  const conn: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: '0.0.0-test', detail: '' }),
    login: async () => {},
    run: async () => {},
    respond: () => {},
    stop: async () => {}
  }
  const svc = new ChatService({
    skillSource: source,
    userData: mkdtempSync(join(tmpdir(), 'kd-model-ud-')),
    emit: () => {},
    openExternal: async () => {},
    connectionFactory: () => conn
  })
  const root = mkdtempSync(join(tmpdir(), 'kd-model-project-'))
  expect(await svc.models(root, 'claude')).toEqual({ provider: 'claude', supported: false, models: [], selected: null })
  await expect(svc.setModel(root, 'claude', { model: 'claude-opus', effort: null })).rejects.toThrow('아직 모델 고르기를 지원하지 않아요')
})
/**
 * 앱 안쪽 통로 전체 — preload(`window.knuaf.chat`) → ipc → 설정 → 다음 `turn/start`.
 * 가짜 app-server 만 쓰고, 실계정 로그인·model/list 조회는 하지 않는다.
 */
test('앱 통로: 목록을 받고, 고른 모델이 설정에 남아 다음 전송의 turn/start 에 실린다', async () => {
  const { launch, openProject, synthProject } = await import('./helpers')
  const dir = mkdtempSync(join(tmpdir(), 'kd-model-app-'))
  const log = join(dir, 'turns.jsonl')
  const state = join(dir, 'state')
  const userData = join(dir, 'userdata')
  writeFileSync(log, '')
  writeFileSync(state, 'chatgpt\n')
  const root = synthProject()
  const { electronApp, page } = await launch({
    userData,
    env: fakeCodexEnv(dir, { FAKE_CODEX_STATE: state, FAKE_CODEX_TURN_LOG: log })
  })
  type ChatApi = {
    models: (root: string, provider: string) => Promise<{ result?: { supported: boolean; models: { model: string; name: string }[]; selected: ModelChoice | null } ; error?: { message: string } }>
    setModel: (root: string, provider: string, choice: ModelChoice | null) => Promise<{ result?: ModelChoice | null; error?: { message: string } }>
    send: (root: string, provider: string, text: string, requestId: string) => Promise<{ result?: unknown; error?: { message: string } }>
  }
  try {
    await openProject(page, root)
    const list = await page.evaluate(
      ([r]) => (window as unknown as { knuaf: { chat: ChatApi } }).knuaf.chat.models(r, 'codex'),
      [root] as const
    )
    expect(list.error).toBeUndefined()
    expect(list.result?.supported).toBe(true)
    expect(list.result?.models.map((m) => m.model).sort()).toEqual(['gpt-astra', 'gpt-luna', 'gpt-sol', 'gpt-terra'])
    expect(list.result?.selected).toBeNull()

    const picked = await page.evaluate(
      ([r]) => (window as unknown as { knuaf: { chat: ChatApi } }).knuaf.chat.setModel(r, 'codex', { model: 'gpt-sol', effort: 'high' }),
      [root] as const
    )
    expect(picked.error).toBeUndefined()
    expect(picked.result).toEqual({ model: 'gpt-sol', effort: 'high' })
    // 선택은 대화 파일이 아니라 설정에 남는다 — 대화 저장 형식은 그대로다.
    const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf-8')) as { chat_models?: { codex?: ModelChoice } }
    expect(saved.chat_models?.codex).toEqual({ model: 'gpt-sol', effort: 'high' })

    // 폴더를 열자마자 앱이 준비(사이드카 쓰기) 중이면 main 이 전송을 거절한다 — 화면은
    // 준비가 끝날 때까지 기다렸다 보낸다(store/chat.ts). IPC 를 직접 부르므로 여기서 기다린다.
    let sent: { result?: unknown; error?: { message: string } } = {}
    for (let i = 0; i < 60; i++) {
      sent = await page.evaluate(
        ([r]) => (window as unknown as { knuaf: { chat: ChatApi } }).knuaf.chat.send(r, 'codex', '안녕하세요', 'req-app-model'),
        [root] as const
      )
      if (!sent.error?.message.includes('저장·검사 작업 중')) break
      await page.waitForTimeout(500)
    }
    expect(sent.error).toBeUndefined()
    await expect.poll(() => readFileSync(log, 'utf-8'), { timeout: 30_000 }).not.toBe('')
    const turns = readFileSync(log, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(turns).toEqual([{ model: 'gpt-sol', effort: 'high' }])
  } finally {
    await electronApp.close()
  }
})
