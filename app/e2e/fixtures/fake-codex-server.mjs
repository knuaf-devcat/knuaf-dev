#!/usr/bin/env node
/**
 * 가짜 `codex app-server` — 시험용. `codex.ts`가 실제로 읽는 것만 맞춘다(검토 IMPL-R1-05).
 *
 * PATH 앞자리에 `codex` 이름으로 두고 쓴다. 실제 codex 가 깔린 기계와 CI 가 같은
 * 장면을 보게 하려는 것이지 새 시험 체계가 아니다. stdio 로 줄 단위 JSON-RPC 다.
 *
 * 환경변수
 *   FAKE_CODEX_MODE   logged-in(기본) | logged-out | dead(시작하자마자 끝난다)
 *   FAKE_CODEX_STATE  로그인 시작을 기억할 파일 하나 — 있으면 account/read 가 chatgpt
 *   FAKE_CODEX_REPLY  turn/start 뒤에 보낼 도우미 글의 **파일 경로**(예: 질문 원문)
 *   FAKE_CODEX_ASK    1이면 turn/start 뒤에 권한 요청을 보내고 턴을 끝내지 않는다
 *   FAKE_CODEX_ASK_COMMAND  권한 요청의 command (기본 `cat /etc/hosts`, 빈 값이면 필드 생략)
 *   FAKE_CODEX_ASK_REASON   권한 요청의 reason (기본 쉬운 이유 한 줄, 빈 값이면 필드 생략)
 *   FAKE_CODEX_DELAY_MS     모든 요청 응답을 이만큼 늦춘다(기본 0) — 느린 기계 조건 재현용
 *   FAKE_CODEX_MODELS       `model/list` 가 돌려줄 모델 배열(JSON). 없으면 Sol·Terra·Astra·Luna 기본값
 *   FAKE_CODEX_TURN_LOG     `turn/start` 로 온 model·effort 를 한 줄씩 덧붙일 파일 — 시험이 읽는다
 *   FAKE_CODEX_APPLIED_LOG  `turn/start` 뒤 그 대화에 **실제로 적용된** model·effort — 생략이
 *                           이전 값을 유지하는 계약(턴 덮어쓰기)을 흉내 내는 상태 기록
 *   FAKE_CODEX_DEFAULT_MODEL / FAKE_CODEX_DEFAULT_EFFORT
 *                           새 대화(과 `ephemeral` 대화)의 서버 기본값. 기본 `gpt-default` / `medium`
 *   FAKE_CODEX_INIT_DELAY_MS
 *                           initialize 응답을 늦추고, 그 전에 온 요청을 `Not initialized` 로 거절한다
 *   FAKE_CODEX_EPHEMERAL_FAIL_TIMES
 *                           기본값 조회용 `thread/start(ephemeral:true)` 를 그 횟수만큼 오류로 거절한다
 *   FAKE_CODEX_MODELS_FAIL_TIMES  모델 목록 조회를 처음 N회 오류로 거절한다(복구 UI 시험).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const MODE = process.env.FAKE_CODEX_MODE ?? 'logged-in'
if (MODE === 'dead') process.exit(1)

const STATE = process.env.FAKE_CODEX_STATE ?? ''
const REPLY_FILE = process.env.FAKE_CODEX_REPLY ?? ''
const ASK = process.env.FAKE_CODEX_ASK === '1'
/** 권한 요청의 command·reason — 여러 줄 명령/이유만 있는 요청을 재현하려고 열어 둔다(QA2A-R1-02). */
const ASK_COMMAND = process.env.FAKE_CODEX_ASK_COMMAND ?? 'cat /etc/hosts'
const ASK_REASON = process.env.FAKE_CODEX_ASK_REASON ?? '논문 폴더 밖 파일을 읽으려고 해요'
/** 응답 지연(ms) — 느린 기계(CI) 조건을 만들기 위한 시험 전용 스위치. 기본 0(동작 불변). */
const DELAY_MS = Math.max(0, Number(process.env.FAKE_CODEX_DELAY_MS ?? 0) || 0)
/** 턴을 끝내지 않는다 — "작업 중" 화면을 안정적으로 본다. `after-delta` 면 답 첫 조각(전달 확인)을 보낸 뒤 붙잡는다. */
const HOLD = process.env.FAKE_CODEX_HOLD === '1'
const HOLD_AFTER_DELTA = process.env.FAKE_CODEX_HOLD === 'after-delta'
/** `model/list` 응답 — 시험이 요금제별 목록을 흉내 낼 수 있게 환경변수로 바꾼다. */
const TURN_LOG = process.env.FAKE_CODEX_TURN_LOG ?? ''
const APPLIED_LOG = process.env.FAKE_CODEX_APPLIED_LOG ?? ''
/** 새 대화에 서버가 실제로 쓰는 기본값 — 앱은 이것을 '되돌리기' 값으로 쓴다. */
const DEFAULT_MODEL = process.env.FAKE_CODEX_DEFAULT_MODEL ?? 'gpt-default'
const DEFAULT_EFFORT = process.env.FAKE_CODEX_DEFAULT_EFFORT ?? 'medium'
/** initialize 전 요청 거절 + 응답 지연(서버가 아직 초기화 중인 상태 재현). */
const INIT_DELAY_MS = Math.max(0, Number(process.env.FAKE_CODEX_INIT_DELAY_MS ?? 0) || 0)
/** 기본값 조회(ephemeral thread)만 실패시키는 횟수 — 실패 뒤 재조회 경로를 시험한다. */
let ephemeralFailures = Math.max(0, Number(process.env.FAKE_CODEX_EPHEMERAL_FAIL_TIMES ?? 0) || 0)
let modelListFailures = Math.max(0, Number(process.env.FAKE_CODEX_MODELS_FAIL_TIMES ?? 0) || 0)
const MODELS = (() => {
  const raw = process.env.FAKE_CODEX_MODELS
  if (raw) { try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] } }
  const one = (id, name, efforts, isDefault = false) => ({
    id, model: id, displayName: name, description: '',
    hidden: false, supportsPersonality: false, upgrade: null, upgradeInfo: null, availabilityNux: null,
    modelSpecialty: null, inputModalities: [], multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [],
    defaultServiceTier: null, availableAccessPrograms: null, isDefault,
    supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e, description: '' })),
    defaultReasoningEffort: efforts[0]
  })
  return [
    one('gpt-sol', 'Sol', ['medium', 'high'], true),
    one('gpt-terra', 'Terra', ['low', 'medium', 'high']),
    one('gpt-luna', 'Luna', ['low', 'medium']),
    one('gpt-astra', 'Astra', ['medium', 'high'])
  ]
})()

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const loggedIn = () => MODE === 'logged-in' || (MODE === 'logged-out' && !!STATE && existsSync(STATE))
const replyText = () => {
  if (!REPLY_FILE) return ''
  try { return readFileSync(REPLY_FILE, 'utf8') } catch { return '' }
}

let threadId = 't-fake'
let serverSeq = 9000
/** 서버가 아직 initialize 를 못 받았으면 다른 요청은 거절한다(문서의 초기화 계약). */
let initialized = false
/** 대화별로 **실제 적용된** model·effort. 턴 덮어쓰기가 뒤 턴에 남는 계약을 흉내 낸다. */
const threads = new Map()
/** 앱 재시작 경계 재현용 — 대화 상태를 파일에 남겨 다음 프로세스가 같은 대화를 이어받는다. */
const THREAD_FILE = process.env.FAKE_CODEX_THREAD_STATE ?? ''
if (THREAD_FILE && existsSync(THREAD_FILE)) {
  try {
    const v = JSON.parse(readFileSync(THREAD_FILE, 'utf8'))
    if (typeof v?.threadId === 'string') threads.set(v.threadId, { model: v.model, effort: v.effort })
  } catch { /* 잘린 파일은 무시 */ }
}
const saveThread = (id, st) => {
  if (THREAD_FILE) writeFileSync(THREAD_FILE, JSON.stringify({ threadId: id, model: st.model, effort: st.effort }))
}
const threadState = (id) => {
  if (!threads.has(id)) threads.set(id, { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT })
  return threads.get(id)
}
let ephemeralSeq = 0
/** `thread/start`·`thread/resume` 응답 — 앱이 대화의 model·effort 를 읽는다. */
const threadResult = (id, turns = []) => {
  const st = threadState(id)
  return {
    thread: { id, turns, ephemeral: false },
    model: st.model, modelProvider: 'openai', serviceTier: null,
    disabledPluginIds: [], cwd: process.cwd(), instructionSources: [],
    approvalPolicy: 'on-request', approvalsReviewer: null, sandbox: { type: 'workspaceWrite' },
    reasoningEffort: st.effort
  }
}

function handle(message) {
  // 답이 없는 것: `initialized` 알림, 그리고 우리가 보낸 요청에 대한 앱의 응답.
  if (message.method === undefined) return
  if (message.method === 'initialized') { initialized = true; return }
  if (message.id === undefined) return
  const id = message.id
  const params = message.params ?? {}
  if (!initialized && message.method !== 'initialize') {
    return out({ id, error: { code: -32002, message: 'Not initialized' } })
  }
  switch (message.method) {
    case 'initialize':
      // userAgent 의 판(version) 토큰을 앱이 읽는다. 늦게 답해 초기화 중 상태를 만든다.
      if (INIT_DELAY_MS > 0) setTimeout(() => out({ id, result: { userAgent: 'codex_cli_rs/0.0.0-test' } }), INIT_DELAY_MS)
      else out({ id, result: { userAgent: 'codex_cli_rs/0.0.0-test' } })
      return
    case 'account/read':
      return out({ id, result: { account: loggedIn() ? { type: 'chatgpt' } : null } })
    case 'account/login/start':
      if (STATE) writeFileSync(STATE, 'chatgpt\n')
      return out({ id, result: { loginId: 'fake', authUrl: 'about:blank' } })
    case 'skills/list': {
      const cwd = (params.cwds ?? [])[0] ?? process.cwd()
      return out({ id, result: { data: [{ skills: [{ path: `${cwd}/.agents/skills/knuaf-dev/SKILL.md`, enabled: true }] }] } })
    }
    case 'thread/start':
    case 'thread/resume': {
      // `ephemeral` 은 앱이 '서버 기본값'을 물을 때 쓴다 — 디스크에 남지 않는 대화 하나.
      if (params.ephemeral === true) {
        if (ephemeralFailures > 0) {
          ephemeralFailures -= 1
          return out({ id, error: { code: -32603, message: 'temporary failure' } })
        }
        const ephId = `t-ephemeral-${++ephemeralSeq}`
        threads.set(ephId, { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT })
        return out({ id, result: threadResult(ephId) })
      }
      threadId = params.threadId ?? 't-fake'
      return out({ id, result: threadResult(threadId) })
    }
    case 'model/list':
      if (modelListFailures > 0) {
        modelListFailures -= 1
        return out({ id, error: { code: -32603, message: '모델 목록 임시 오류' } })
      }
      // 쪽 나눔은 흉내 내지 않는다(앱은 nextCursor 가 없으면 멈춘다).
      return out({ id, result: { data: MODELS, nextCursor: null } })
    case 'turn/start': {
      // 앱이 실제로 보낸 값만 남긴다 — "안 골랐을 때는 키가 없다"를 시험이 구분할 수 있게.
      if (TURN_LOG) {
        const rec = {}
        if ('model' in params) rec.model = params.model
        if ('effort' in params) rec.effort = params.effort
        appendFileSync(TURN_LOG, `${JSON.stringify(rec)}\n`)
      }
      /**
       * 턴 덮어쓰기 계약: 보낸 model·effort 는 이 대화의 **뒤 턴에도** 남는다.
       * 생략은 "기본값으로 돌아가기"가 아니라 "지금 값을 유지"다(문서의 Turns 절).
       */
      const st = threadState(params.threadId ?? threadId)
      if ('model' in params && typeof params.model === 'string' && params.model) st.model = params.model
      if ('effort' in params && typeof params.effort === 'string' && params.effort) st.effort = params.effort
      if (APPLIED_LOG) appendFileSync(APPLIED_LOG, `${JSON.stringify({ ...st })}\n`)
      saveThread(params.threadId ?? threadId, st)
      const turnId = 'u-fake'
      out({ id, result: { turn: { id: turnId } } })
      out({ method: 'turn/started', params: { threadId, turn: { id: turnId } } })
      if (ASK) {
        // 허락 카드 장면 — 턴을 끝내지 않고 학생의 답을 기다린다.
        // 요청 id 는 최상위에 있어야 한다(줄 단위 JSON-RPC — 앱도 그렇게 읽는다).
        out({ id: ++serverSeq, method: 'item/commandExecution/requestApproval', params: {
          threadId,
          ...(ASK_COMMAND ? { command: ASK_COMMAND } : {}),
          ...(ASK_REASON ? { reason: ASK_REASON } : {})
        } })
        return
      }
      if (HOLD) return
      if (HOLD_AFTER_DELTA) {
        out({ method: 'item/agentMessage/delta', params: { threadId, itemId: 'i-fake', delta: '답을 쓰고 있어요' } })
        return
      }
      const text = replyText()
      if (text) {
        out({ method: 'item/agentMessage/delta', params: { threadId, itemId: 'i-fake', delta: text } })
        out({ method: 'item/completed', params: { threadId, item: { id: 'i-fake', type: 'agentMessage', text } } })
      }
      out({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
      return
    }
    case 'turn/interrupt':
      return out({ id, result: {} })
    case 'item/commandExecution/requestApproval':
      return
    default:
      return out({ id, error: { code: -32601, message: `fake codex: 모르는 요청 ${message.method}` } })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
    const line = buffer.slice(0, i)
    buffer = buffer.slice(i + 1)
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (DELAY_MS > 0) setTimeout(() => { try { handle(msg) } catch { /* 잘린 요청 */ } }, DELAY_MS)
      else handle(msg)
    } catch { /* 줄이 잘려 왔다 */ }
  }
})
