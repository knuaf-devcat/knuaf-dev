export type Provider = 'codex' | 'claude'
/**
 * 학생이 고른 모델과 생각 깊이. 고르지 않았으면 `null` 이고, 그때 앱은 지금까지처럼
 * 모델·effort 를 **보내지 않는다**(CLI·계정 기본값). 대화 파일이 아니라 설정에 남는다 —
 * `.knuaf-gui/chat-*.json` 의 저장 형식은 그대로다.
 */
export interface ModelChoice { model: string; effort: string | null }
/** `model/list` 가 알려 준, 이 계정이 쓸 수 있는 모델 하나. */
export interface ChatModelInfo {
  /** `turn/start` 의 `model` 에 그대로 넣는 값. */
  model: string
  /** 학생 화면에 보일 이름(displayName). */
  name: string
  description: string
  /** 고를 수 있는 생각 깊이(`supportedReasoningEfforts`). */
  efforts: string[]
  defaultEffort: string | null
  isDefault: boolean
}
/**
 * 모델 목록 통로의 응답.
 * `supported:false` 는 그 공급자에 아직 이 통로가 없다는 뜻이다(이번 판의 Claude) —
 * 화면은 추천·목록을 띄우지 않고 지금처럼 기본값으로 둔다.
 */
export interface ChatModels {
  provider: Provider
  supported: boolean
  models: ChatModelInfo[]
  /** 설정에 남은 선택. 목록에 없으면 `null`(안 골름) — 칩도 선택 없음으로 보인다. */
  selected: ModelChoice | null
  /** 목록을 받지 못했을 때의 이유. 있으면 `models` 는 비어 있다. */
  error?: string
}
/**
 * 'interrupted' 는 앱이 죽은 뒤 복구했을 때, 'stopped' 는 학생이 중단을 눌렀을 때.
 * 둘을 한 상태로 쓰면 화면이 멀쩡히 살아 있는 앱을 두고 "종료됐어요"라고 말한다(GUI-05).
 */
export type RunState = 'idle' | 'running' | 'permission' | 'interrupted' | 'stopped' | 'error'
export interface ChatMessage {
  id: string; role: 'user' | 'assistant' | 'system'; text: string; at: string
  delivery?: 'pending' | 'sent' | 'uncertain'
}
export interface PermissionRequest { id: string; title: string; detail: string }
export interface ChatSnapshot {
  root: string; provider: Provider; sessionId?: string; state: RunState
  messages: ChatMessage[]; permission?: PermissionRequest; error?: string
  skillHash?: string; skillLoaded?: boolean
  /** 전송 중 확인된 인증 실패. 상태 조회의 옛 로그인 정보보다 우선한다. */
  authRequired?: boolean
}
/**
 * 연결 도구의 상태. `connected` 하나로는 "로그인이 필요해요"와 "확인하지 못했어요"를
 * 구별할 수 없다 — Claude 의 `auth status` 가 시간 초과·오류·잘못된 JSON 으로 실패해도
 * 예전에는 조용히 `connected:false` 가 되어 화면이 로그인을 요구했다.
 *
 * `probe` 는 그 구분이다: `'ok'` = CLI 가 정상 응답을 줬다(연결 여부는 지금 규칙대로),
 * `'failed'` = 실행 실패·시간 초과·파싱 실패라 **연결 여부를 알 수 없다**.
 * 값이 없으면 `'ok'` 로 읽는다 — 기존 호출자의 동작이 그대로다.
 */
export interface ConnectionStatus { installed: boolean; connected: boolean; version: string | null; detail: string; probe?: 'ok' | 'failed' }
export interface Artifact { path: string; name: string; kind: 'docx' | 'xlsx' | 'pdf'; modified: number }
export interface Material { path: string; role: 'manuscript' | 'finance' | 'reference'; name: string }
export type Preview = { kind: 'pdf'; url: string } | { kind: 'xlsx'; sheets: { name: string; rows: string[][]; truncated: boolean }[] } | { kind: 'unavailable'; reason: string }
export type GuiReply<T> = { result: T; error?: never } | { error: string; result?: never }

// ---------------------------------------------------------------- 모델 추천 (형님 확정표)
//
// 형님 확정표(`../DECISIONS.md` '최종 추천 레인 배치')를 **그대로** 옮긴 데이터다. 화면은
// 이 상수와 `codexRecommendations()` 만 쓰면 되고, 문구를 화면 쪽에서 다시 짓지 않는다.
//
// 값은 **별칭**(sol·terra·astra·luna)이다. 계정이 실제로 쓰는 모델 id 는 요금제마다 달라
// 아직 확인되지 않았다 — `model/list` 가 준 model/name 의 **끝 낱말**이 별칭인지로 찾는다
// (`resolveCodexAlias`). 실제 목록을 실기기에서 확인하면 `CODEX_MODEL_ALIASES` 만 고치면 된다.

/** 형님이 말한 작업 레인. 검토는 항상 새 대화로 시작한다. */
export type WorkLane = 'design' | 'research' | 'writing' | 'repeat' | 'review'
export const WORK_LANES: { lane: WorkLane; label: string }[] = [
  { lane: 'design', label: '설계' },
  { lane: 'research', label: '자료 찾기' },
  { lane: 'writing', label: '글쓰기' },
  { lane: 'repeat', label: '반복 작업' },
  { lane: 'review', label: '검토(새 대화)' }
]
export type CodexTier = 'low' | 'high'
/** 구독 줄별 추천 — 형님 표 그대로(낮음/높음). */
export const CODEX_TIER_MODELS: Record<CodexTier, Record<WorkLane, string>> = {
  low: { design: 'terra', research: 'luna', writing: 'luna', repeat: 'luna', review: 'terra' },
  high: { design: 'sol', research: 'astra', writing: 'terra', repeat: 'luna', review: 'astra' }
}
/** 별칭 판정 낱말. 목록의 model·name 의 **끝 낱말**이 이 낱말이면 그 별칭이다. */
export const CODEX_MODEL_ALIASES: Record<string, string[]> = {
  sol: ['sol'], terra: ['terra'], astra: ['astra'], luna: ['luna']
}

/**
 * 다른 공급자로 우회되는 id 인가 — OpenAI 쪽 id 에는 `공급자/` 접두어가 없고, 다른 공급자
 * 모델은 전부 `<공급자>/…` 형식이다(DQA-01 실측: `anthropic/claude-…`,
 * `commandcode-auth/gpt-5.6-terra`). 이런 id 는 이 ChatGPT 계정의 모델이 아니므로 목록·추천·
 * 전송 어디에도 올리지 않는다 — 고르면 다른 회사·다른 과금 경로로 간다.
 */
export function isCrossProviderModelId(model: string): boolean {
  return model.includes('/')
}

export interface LaneRecommendation { lane: WorkLane; label: string; model: string }
export interface CodexRecommendation {
  /** 이 계정 목록으로 고른 줄. Sol·Astra 가 보이면 높음, 아니면 낮음. */
  tier: CodexTier
  /** 그 줄에서 **목록에 있는** 모델만 남긴 추천. 목록에 없는 모델은 빼고 칩에도 안 띄운다. */
  lanes: LaneRecommendation[]
  /** 모델별 용도 한 줄 — `model` 키, 값은 그 모델이 추천된 레인 이름들(` · ` 로 이은 문구). */
  byModel: Record<string, { alias: string; lanes: WorkLane[]; purpose: string }>
}

/**
 * 별칭 하나가 가리키는 모델을 계정 목록에서 찾는다. 없으면 undefined.
 *
 * 예전에는 model·name **어디에든** 별칭 낱말이 들어 있으면 맞다고 봤다. 그래서
 * `commandcode-auth/gpt-5.6-terra` 같은 다른 공급자 모델이 terra 로 잡혀 추천이 붙었다
 * (DQA-01). 지금은 **끝 낱말**만 본다 — `GPT-6.1-Sol` → `sol`, `GPT Sol (높음)` → `sol`.
 * 다른 공급자 id 는 애초에 넘기지 않지만, 넘어와도 여기서 다시 거른다. 세대가 읽히는
 * 후보가 있으면 가장 높은 GPT 버전을 고르고, 없거나 동률이면 목록의 첫 후보를 쓴다.
 */
export function resolveCodexAlias(models: Pick<ChatModelInfo, 'model' | 'name'>[], alias: string): string | undefined {
  const words = (CODEX_MODEL_ALIASES[alias] ?? [alias]).map((w) => w.toLowerCase())
  let best: string | undefined
  let bestVersion: number[] | null = null
  for (const m of models) {
    if (isCrossProviderModelId(m.model)) continue
    if (!words.includes(lastWord(m.model)) && !words.includes(lastWord(m.name))) continue
    const version = codexVersion(m.model) ?? codexVersion(m.name)
    if (best === undefined || (version && (!bestVersion || compareVersion(version, bestVersion) > 0))) {
      best = m.model
      bestVersion = version
    }
  }
  return best
}

/** GPT 뒤의 세대만 읽는다 — 다른 숫자(설명·날짜)를 모델 버전으로 오인하지 않는다. */
function codexVersion(text: string): number[] | null {
  const match = /\bgpt[-\s]+(\d+(?:\.\d+)*)/i.exec(text)
  return match ? match[1].split('.').map(Number) : null
}

function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 낱말 하나로 쪼갠 마지막 토큰 — `gpt-6.1-sol` → `sol`, `GPT Sol (높음)` → `sol`. */
function lastWord(text: string): string {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return words[words.length - 1] ?? ''
}

/**
 * 계정이 쓸 수 있는 모델 목록 → 형님 표의 추천.
 *
 * 줄 판정: 이번 판 규칙은 **높음 줄 전용 모델(Sol·Astra)이 목록에 하나라도 보이면 높음**이다
 * (`../DECISIONS.md`: "Sol·Astra 가 있으면 높음"). 요금제별 실제 목록이 아직 확인되지 않아
 * 추측을 최소화한 규칙이고, 실기기 확인 뒤 이 함수 하나만 고치면 화면은 그대로다.
 */
export function codexRecommendations(models: Pick<ChatModelInfo, 'model' | 'name'>[]): CodexRecommendation {
  const highOnly = ['sol', 'astra'].filter((a) => resolveCodexAlias(models, a))
  const tier: CodexTier = highOnly.length > 0 ? 'high' : 'low'
  const lanes: LaneRecommendation[] = []
  const byModel: CodexRecommendation['byModel'] = {}
  for (const { lane, label } of WORK_LANES) {
    const alias = CODEX_TIER_MODELS[tier][lane]
    const model = resolveCodexAlias(models, alias)
    if (!model) continue
    lanes.push({ lane, label, model })
    const got = (byModel[model] ??= { alias, lanes: [], purpose: '' })
    got.lanes.push(lane)
  }
  for (const entry of Object.values(byModel)) {
    const labels = WORK_LANES.filter((l) => entry.lanes.includes(l.lane)).map((l) => l.label)
    entry.purpose = labels.join(' · ')
  }
  return { tier, lanes, byModel }
}

/**
 * 설정에 남은 선택을 이 계정 목록에 비춰 정규화한다.
 * - 목록을 아직 모르면(`null`) 선택을 그대로 둔다 — 목록을 못 받았다고 학생 선택을 지우지 않는다.
 * - 목록에 없는 모델이면 `null`(안 골름): 요금제가 바뀌어 그 모델이 사라져도 다음 전송이
 *   실패하지 않고 지금까지처럼 기본값으로 돈다.
 * - 그 모델이 지원하지 않는 생각 깊이는 버린다(모델 선택은 살린다).
 */
export function effectiveModelChoice(
  choice: ModelChoice | null | undefined,
  models: ChatModelInfo[] | null
): ModelChoice | null {
  const model = typeof choice?.model === 'string' ? choice.model.trim() : ''
  if (!model) return null
  const effort = typeof choice?.effort === 'string' && choice.effort ? choice.effort : null
  if (!models) return { model, effort }
  const info = models.find((m) => m.model === model)
  if (!info) return null
  return { model, effort: effort && info.efforts.includes(effort) ? effort : null }
}
