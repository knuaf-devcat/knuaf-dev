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

function handle(message) {
  // 답이 없는 것: `initialized` 알림, 그리고 우리가 보낸 요청에 대한 앱의 응답.
  if (message.method === undefined) return
  if (message.id === undefined) return
  const id = message.id
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize':
      // userAgent 의 판(version) 토큰을 앱이 읽는다.
      return out({ id, result: { userAgent: 'codex_cli_rs/0.0.0-test' } })
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
    case 'thread/resume':
      threadId = params.threadId ?? 't-fake'
      return out({ id, result: { thread: { id: threadId, turns: [] } } })
    case 'model/list':
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
