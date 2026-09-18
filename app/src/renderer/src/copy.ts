/**
 * copy.ts — every user-facing string of the companion app in one place.
 *
 * Tone: calm, short, plain Korean in '-요' form. The student never sees a command,
 * a JSON key or a model name here; technical names live only in FIELD_HINT (고급).
 * Sanctioned wording comes from skills/knuaf-doc/SKILL.md (credit line, four lanes,
 * "not approval"), references/interview-ui.md (chat is the record; the app is read-only)
 * and references/parser-setup.md (Kordoc sentence).
 *
 * No React, no imports from rpc.ts: errors are duck-typed `{ code, message }` so this
 * module can be used from the store, the screens and tests alike.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ErrorCopy = {
  /** One calm sentence: what happened. */
  title: string
  /** What the student does next — a screen or a button, never a command or JSON. */
  action: string | null
  /** 'status' is neutral (e.g. cancelled), 'warning' is recoverable, 'error' needs attention. */
  kind: 'error' | 'warning' | 'status'
}

const ERROR_COPY: Record<string, ErrorCopy> = {
  // gg_core business rules (sidecar rpc.py classify_exception)
  lock_held: {
    title: '다른 작업이 이 폴더를 잠그고 있어요.',
    action: '"문제 해결" 화면에서 잠금 상태를 확인해 주세요. 에이전트가 저장 중이면 끝날 때까지 기다리면 돼요.',
    kind: 'warning'
  },
  lock_ambiguous: {
    title: '잠금 기록이 불명확해서 해제하지 않았어요.',
    action: '"문제 해결" 화면의 잠금 정보를 보고, 다른 창에서 에이전트가 이 폴더에 저장 중이 아닌지 확인해 주세요.',
    kind: 'warning'
  },
  revision_stale: {
    title: '정본이 그사이 바뀌었어요.',
    action: '"새로고침"을 누른 뒤 다시 시도해 주세요.',
    kind: 'warning'
  },
  overwrite_refused: {
    title: '같은 이름의 파일이 이미 있어 덮어쓰지 않았어요.',
    action: '"새 버전 경로" 버튼으로 다른 이름을 고른 뒤 다시 실행해 주세요.',
    kind: 'warning'
  },
  business_rule: {
    title: '지금 상태에서는 할 수 없는 작업이에요.',
    action: '아래 설명을 확인해 주세요. 필요하면 에이전트 채팅에서 알려 주세요.',
    kind: 'error'
  },
  deps_not_ready: {
    title: '필요한 패키지가 아직 준비되지 않았어요.',
    action: '"문제 해결" 화면에서 "패키지 준비" 버튼을 눌러 주세요.',
    kind: 'warning'
  },
  not_found: {
    title: '파일이나 폴더를 찾지 못했어요.',
    action: '경로를 다시 확인하거나, 홈에서 폴더를 다시 열어 주세요.',
    kind: 'error'
  },
  permission: {
    title: '파일을 읽거나 쓸 권한이 없어요.',
    action: '다른 프로그램에서 그 파일을 열어 두었다면 닫고, 폴더 권한을 확인한 뒤 다시 시도해 주세요.',
    kind: 'error'
  },
  timeout: {
    title: '시간 안에 끝나지 않아 멈췄어요.',
    action: '잠시 후 다시 시도해 주세요. 계속 반복되면 "설정" 화면의 실행기 로그를 확인해 주세요.',
    kind: 'warning'
  },
  cancelled: {
    title: '취소했어요.',
    action: null,
    kind: 'status'
  },
  invalid_params: {
    title: '입력값이 맞지 않아요.',
    action: '입력란을 확인한 뒤 다시 시도해 주세요.',
    kind: 'error'
  },
  invalid_request: {
    title: '앱과 실행기 사이 요청이 어긋났어요.',
    action: '"설정" 화면에서 실행기를 다시 시작해 주세요.',
    kind: 'error'
  },
  internal: {
    title: '예상하지 못한 문제가 생겼어요.',
    action: '"설정" 화면의 실행기 로그를 확인하고, 반복되면 에이전트 채팅에서 알려 주세요.',
    kind: 'error'
  },
  // main process (sidecar.ts / ipc.ts)
  sidecar_down: {
    title: 'Python 실행기가 꺼져 있어요.',
    action: '"설정" 화면에서 "적용·재시작"을 눌러 주세요.',
    kind: 'error'
  },
  sidecar_exited: {
    title: 'Python 실행기가 도중에 종료됐어요.',
    action: '"설정" 화면에서 실행기를 다시 시작한 뒤, 하던 작업을 다시 실행해 주세요.',
    kind: 'error'
  },
  spawn_failed: {
    title: 'Python 실행기를 시작하지 못했어요.',
    action: '"설정" 화면의 Python 실행기 경로를 확인해 주세요. 비워 두면 자동으로 골라요.',
    kind: 'error'
  },
  // sidecar __main__.py
  python_too_old: {
    title: 'Python 버전이 너무 낮아요. 3.10 이상이 필요해요.',
    action: '"설정" 화면에서 더 최신 Python을 지정해 주세요.',
    kind: 'error'
  },
  scripts_missing: {
    title: '스킬 스크립트 폴더를 찾지 못했어요.',
    action: '앱을 다시 설치하거나, "설정" 화면의 실행기 로그에 적힌 위치를 확인해 주세요.',
    kind: 'error'
  },
  default: {
    title: '문제가 생겼어요.',
    action: '아래 내용을 확인해 주세요. 반복되면 에이전트 채팅에서 알려 주세요.',
    kind: 'error'
  }
}

/** Human wording for an error code. Unknown codes fall back to `default`. */
export function errorCopy(code: string): ErrorCopy {
  return ERROR_COPY[code] ?? ERROR_COPY.default
}

export type DescribedError = ErrorCopy & {
  /** `(code) message` — always shown somewhere (details, log), never as the headline. */
  raw: string
  code: string | null
}

function readCoded(e: unknown): { code: string | null; message: string } {
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; message?: unknown }
    const code = typeof o.code === 'string' && o.code ? o.code : null
    const message = typeof o.message === 'string' ? o.message : String(e)
    return { code, message }
  }
  return { code: null, message: String(e) }
}

/** Duck-typed on `{ code, message }` (RpcError, RpcFailure, plain Error, string). */
export function describeError(e: unknown): DescribedError {
  const { code, message } = readCoded(e)
  const copy = errorCopy(code ?? 'default')
  return { ...copy, code, raw: code ? `(${code}) ${message}` : message }
}

// ---------------------------------------------------------------------------
// Label maps
// ---------------------------------------------------------------------------

export const STATUS_LABEL: Record<string, string> = {
  pass: '통과',
  fail: '실패',
  blocked: '보류',
  pending: '대기',
  not_configured: '미설정',
  needs_user: '내 답변 필요',
  needs_evidence: '근거 필요',
  ready: '진행 가능',
  empty: '비어 있음',
  drafting: '작성 중',
  review_ready: '검토 준비',
  installed: '설치됨',
  missing: '없음',
  live: '실행 중',
  stale_releasable: '남은 잠금',
  foreign_host: '다른 기기',
  ambiguous: '불명확',
  none: '없음'
}

export const SEVERITY_LABEL: Record<string, string> = {
  error: '오류',
  warning: '경고',
  info: '안내'
}

export const OWNER_LABEL: Record<string, string> = {
  skill: '스킬',
  user: '나',
  professor: '교수'
}

export const REVIEW_KIND_LABEL: Record<string, string> = {
  content: '내용',
  logic: '논리',
  calculation: '계산',
  docx: 'DOCX',
  xlsx: 'XLSX',
  render: '렌더'
}

export const COLLECTION_LABEL: Record<string, string> = {
  sources: '출처',
  facts: '사실',
  sections: '절',
  questions: '질문',
  tasks: '작업',
  reviews: '검토',
  rules: '규칙',
  approvals: '승인',
  outputs: '산출물'
}

/** gg_core.unlock releases only a lock from this same host whose owner process is gone. */
export const LOCK_VERDICT_COPY: Record<string, { title: string; detail: string }> = {
  none: {
    title: '잠금 없음',
    detail: '지금은 아무도 이 폴더를 잠그고 있지 않아요. 해제할 것이 없어요.'
  },
  live: {
    title: '실행 중인 작업이 잠금을 쥐고 있어요',
    detail: '같은 기기의 작업이 아직 살아 있어요. 해제하면 그 작업의 저장이 깨질 수 있어 앱이 해제하지 않아요. 기다리거나 그 작업(에이전트 창)을 확인해 주세요.'
  },
  stale_releasable: {
    title: '남은 잠금이에요',
    detail: '같은 기기에서 이미 종료된 작업이 남긴 잠금이에요. 소유 프로세스가 없는 것을 확인했으니 "잠금 해제"로 풀 수 있어요.'
  },
  foreign_host: {
    title: '다른 기기의 잠금이에요',
    detail: '다른 기기에서 만든 잠금이라 여기서는 그 작업이 살아 있는지 알 수 없어요. 해제는 잠근 기기에서 확인해 주세요.'
  },
  ambiguous: {
    title: '소유 기록이 불명확해요',
    detail: '누가 잠갔는지 읽을 수 없거나 프로세스 상태를 판정할 수 없어요. 앱은 이런 잠금을 보존해요. 다른 창에서 저장 중이 아닌지 직접 확인한 뒤 에이전트에게 알려 주세요.'
  }
}

/** gg_core.user_finish_task_list — the student's own finishing work in 한글. */
export const USER_FINISH_LABEL: Record<string, string> = {
  font_shinmyeongjo: '글꼴 신명조 확인',
  margins: '여백 맞추기',
  page_numbers: '페이지 번호',
  hwp_convert: 'HWP로 저장 후 다시 열어 확인'
}

// ---------------------------------------------------------------------------
// Four lanes (SKILL.md:34 — never one checkmark)
// ---------------------------------------------------------------------------

export type LaneCopy = {
  id: 'machine' | 'content_review' | 'output_review' | 'professor'
  number: '1.' | '2.' | '3.' | '4.'
  title: '기계검사' | '내용검토(독립)' | '실제 출력검토' | '교수 승인'
  description: string
  readyText?: string
  notReadyText?: string
}

export const LANE_COPY: LaneCopy[] = [
  {
    id: 'machine',
    number: '1.',
    title: '기계검사',
    description: '파일 해시·사실·계산·절을 정본과 대조하는 자동 검사예요.',
    readyText: '스킬 검사가 끝난 상태예요(교수 확인 전).',
    notReadyText: '아직 스킬 검사가 끝나지 않았어요.'
  },
  {
    id: 'content_review',
    number: '2.',
    title: '내용검토(독립)',
    description: '작성자와 다른 검토자가 원문과 대조한 기록이에요.',
    readyText: '독립검토 기록이 있어요.',
    notReadyText: '아직 독립검토 기록이 없어요. 기계검사 통과가 이를 대신하지 않아요.'
  },
  {
    id: 'output_review',
    number: '3.',
    title: '실제 출력검토',
    description: '만들어진 DOCX/XLSX 파일의 글꼴·재계산·렌더를 실제로 확인한 결과예요.',
    readyText: '학교 지침이 준비돼 있어요.',
    notReadyText: '학교 지침이 아직 준비되지 않았어요.'
  },
  {
    id: 'professor',
    number: '4.',
    title: '교수 승인',
    description: '교수님이 직접 확인한 기록이에요. 이 앱은 승인을 판정하지 않아요.',
    readyText: '승인 근거 기록이 등록돼 있어요. 앱이 승인을 판정한 것은 아니에요.',
    notReadyText: '별도 기록 확인이 필요해요. 앱이 승인을 판정하지 않아요.'
  }
]

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

export const EMPTY: Record<string, { title: string; body: string; action?: string }> = {
  recent: {
    title: '최근 연 폴더가 없어요',
    body: '논문 작업 폴더를 열면 여기에 기억해 둘게요.',
    action: '폴더 열기…'
  },
  sections: {
    title: '등록된 절이 없어요',
    body: '에이전트가 절을 등록하면 여기 나타나요. 작문은 에이전트 채팅에서 진행해요.'
  },
  tasks_all: {
    title: '지금 막힌 일이 없어요',
    body: '새 질문이나 근거 요청이 생기면 여기에 보여요.'
  },
  tasks_needs_user: {
    title: '내 답변이 필요한 일이 없어요',
    body: '질문이 생기면 에이전트 채팅에서 물어볼 거예요.'
  },
  tasks_needs_evidence: {
    title: '근거가 필요한 일이 없어요',
    body: '출처나 자료가 더 필요해지면 여기에 나타나요.'
  },
  tasks_ready: {
    title: '바로 진행할 수 있는 일이 없어요',
    body: '막힌 항목이 풀리면 여기로 옮겨 와요.'
  },
  checks_filtered: {
    title: '조건에 맞는 검사가 없어요',
    body: '필터나 검색어를 바꿔 보세요.',
    action: '필터 지우기'
  },
  build_tree: {
    title: '아직 발행물이 없어요',
    body: '"검토본 내보내기"나 "DOCX 생성"을 실행하면 build/ 폴더에 쌓여요.'
  },
  user_finish: {
    title: '한글에서 마무리할 일이 없어요',
    body: '글꼴·여백·페이지 번호 항목이 생기면 여기에 보여요.'
  },
  orphans: {
    title: '남은 임시 파일이 없어요',
    body: '저장 도중 끊긴 파일이 있으면 여기 나타나요. 다른 작성자의 것일 수 있어 앱이 지우지 않아요.'
  },
  snapshots: {
    title: '정본 스냅샷이 없어요',
    body: '에이전트가 저장할 때마다 직전 정본이 남아요. 아직 저장 기록이 없어요.'
  }
}

// ---------------------------------------------------------------------------
// Completion messages (shown after an action succeeds)
// ---------------------------------------------------------------------------

export const COMPLETION: Record<string, string> = {
  exported: '발행됨',
  docx_built: 'DOCX를 만들었어요',
  paper_generated: '논문 골격을 만들었어요',
  blank_created: '빈 사본을 만들었어요',
  filled: '값을 채웠어요',
  deps_ready: '패키지를 프로젝트 폴더 안에 준비했어요',
  kordoc_ready: '문서 읽기 도구가 준비됐어요',
  unlocked: '잠금을 해제했어요',
  restored: '이전 정본을 새 개정으로 되돌렸어요',
  init_done: '빈 정본을 만들었어요',
  cancelled: '취소했어요'
}

// ---------------------------------------------------------------------------
// Screen intros, onboarding
// ---------------------------------------------------------------------------

export type ScreenId = 'home' | 'dashboard' | 'checks' | 'tasks' | 'sections' | 'outputs' | 'troubleshoot' | 'settings'

export const SCREEN_INTRO: Record<ScreenId, string> = {
  home: '논문 작업 폴더를 열어 상태를 보는 곳이에요. 인터뷰와 작문은 여기서 하지 않고 에이전트 채팅에서 해요.',
  dashboard: '기계검사·내용검토·출력검토·교수 승인 네 가지를 따로 보여줘요. 하나의 완료 표시로 합치지 않아요.',
  checks: '검사 결과를 항목별로 보여줘요. 검사를 자동으로 통과시키거나 건너뛰지 않아요.',
  tasks: '무엇이 막혀 있는지 보여줘요. 답변은 여기가 아니라 에이전트 채팅에서 해요.',
  sections: '저장된 절의 본문을 읽기 전용으로 보여줘요. 이 앱에서는 본문을 고치지 않아요.',
  outputs: '검토본·DOCX·엑셀 산출물을 만들고 build/ 폴더를 보여줘요. 기존 파일을 덮어쓰지 않아요.',
  troubleshoot: '패키지·잠금·정본 스냅샷을 진단하고 복구를 도와줘요. 다른 작성자의 파일은 지우지 않아요.',
  settings: 'Python 실행기와 로그를 관리해요. 이 앱은 아무것도 기기 밖으로 보내지 않아요.'
}

export type OnboardingStep = { id: string; title: string; body: string; actionLabel?: string }

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'open_folder',
    title: '폴더 열기',
    body: '논문 작업에 쓸 폴더를 골라요. 새 빈 폴더여도 괜찮고, 이미 쓰던 폴더여도 돼요.',
    actionLabel: '폴더 열기…'
  },
  {
    id: 'prepare_packages',
    title: '패키지 준비',
    body: '검사와 발행에 필요한 패키지를 프로젝트 폴더 안에만 준비해요. 컴퓨터의 다른 Python은 건드리지 않아요.',
    actionLabel: '패키지 준비'
  },
  {
    id: 'open_helper',
    title: 'AI 도우미 열기',
    body: '버튼을 누르면 앱이 규칙집을 넣고 터미널 창에 AI 도우미(Claude Code)를 켜 "시작하기"까지 대신 입력해요. 인터뷰 답변은 그 창에서 해요.',
    actionLabel: 'AI 도우미 열기'
  }
]

// ---------------------------------------------------------------------------
// Fixed sentences (SKILL.md:8, :15, :24, :34; parser-setup.md:12)
// ---------------------------------------------------------------------------

/** SKILL.md:8 — shown once on first entry, never inside a document or author field. */
export const CREDIT = {
  line1: 'knuaf-doc · 창업논문 작성 도우미',
  line2: 'prod. 특용작물전공 24학번 김대욱'
} as const

/** parser-setup.md:12 — the only sentence said when Kordoc is actually installed. */
export const KORDOC_SENTENCE = '문서를 읽는 데 필요한 도구를 준비할게요. 처음 한 번은 시간이 조금 걸릴 수 있어요.'

export const NO_OVERWRITE_NOTE = '기존 파일은 덮어쓰지 않아요. 같은 이름이 있으면 새 이름을 골라 주세요.'

/** SKILL.md:15, :24 — nothing here counts as school submission or professor approval. */
export const NOT_APPROVAL_NOTE = '교수 승인으로 표시되지 않아요. 검사 통과와 승인은 별개예요.'

export const PRIVACY_NOTE = '이 앱은 아무것도 기기 밖으로 보내지 않아요. 원본과 개인 자료는 작업 폴더에만 있어요.'

/** interview-ui.md — the chat transcript is the record; the app only shows. */
export const READ_ONLY_NOTE = '읽기 전용이에요. 수정은 에이전트 채팅에서 요청해 주세요.'

/** SKILL.md:34 — when no independent review exists, say so first, always. */
export const INDEPENDENT_REVIEW_MISSING = {
  title: '독립검토 미실행',
  body: '작성자와 다른 검토자의 내용검토 기록이 아직 없어요. 기계검사 통과는 내용검토를 대신하지 않아요.'
} as const

// ---------------------------------------------------------------------------
// Form fields (Outputs screen)
// ---------------------------------------------------------------------------

export const FIELD_LABEL: Record<string, string> = {
  paper_input: '에이전트가 만든 입력 파일',
  paper_out: '저장할 이름',
  docx_in: '통합 본문 파일',
  out_path: '저장할 이름',
  font: '글꼴',
  xl_source: '학교 양식 파일(원본)',
  xl_map: '검사 결과 지도',
  xl_blank: '빈 사본 이름',
  xl_writemap: '채우기 지도 파일',
  xl_values: '값 파일',
  xl_filled: '채운 사본 이름',
  xl_final: '재계산된 최종 파일',
  xl_receipts: '영수증 파일들',
  of_input: '변환할 파일',
  of_out: '결과 폴더(새 폴더)'
}

/** Shown under 고급 only — technical names are allowed here. */
export const FIELD_HINT: Record<string, string> = {
  paper_input: '에이전트가 만든 paper-input.json. 폴더 안 상대경로로 적어요.',
  paper_out: '기본값 build/검토전_본문.md. 같은 이름이 있으면 "새 버전 경로"로 바꿔요.',
  docx_in: '절을 하나로 합친 Markdown(build/본문_통합.md).',
  out_path: '폴더 안 상대경로. 기존 파일은 덮어쓰지 않아요.',
  font: '기본 신명조. 최종 글꼴 확인은 한글에서 직접 해요.',
  xl_source: '학교가 준 예시 XLSX. 원본은 읽기만 하고 바꾸지 않아요.',
  xl_map: 'inspect가 만드는 source-map.json. 어느 셀이 입력칸인지 적혀 있어요.',
  xl_blank: 'clear가 만드는 사본(blank-v1.xlsx). 수식·병합·서식은 그대로예요.',
  xl_writemap: '에이전트가 만든 gg-xlsx-fill-map JSON.',
  xl_values: '에이전트가 만든 gg-xlsx-fill-values JSON.',
  xl_filled: 'fill이 만드는 사본(filled-v1.xlsx). 채운 뒤 실제 Excel 재계산이 필요해요.',
  xl_final: 'Office 렌더로 재계산된 XLSX.',
  xl_receipts: 'clear·fill·office 영수증 JSON을 공백으로 구분해 적어요.',
  of_input: '.docx 또는 .xlsx. 실제 Word/Excel을 열어 목차 갱신·재계산·PDF 출력을 해요.',
  of_out: '기본값 build/native. 처음 실행 시 운영체제의 자동화 권한 창이 뜨면 직접 허용해 주세요.'
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

/** '방금' / 'n분 전' / 'n시간 전' / '어제' / 'n일 전' / 'YYYY.MM.DD'. Invalid input is returned as-is. */
export function relativeTime(iso: string | number | Date, now: number | Date = Date.now()): string {
  const t = iso instanceof Date ? iso.getTime() : new Date(iso).getTime()
  if (Number.isNaN(t)) return String(iso)
  const ref = now instanceof Date ? now.getTime() : now
  const diff = ref - t
  if (diff < MINUTE) return '방금'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}분 전`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}시간 전`
  if (diff < 2 * DAY) return '어제'
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}일 전`
  const d = new Date(t)
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`
}

/** 0 B / 512 B / 1.5 KB / 12.3 MB / 2.0 GB */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Office 작업영역이 macOS 개인정보 보호(TCC)에 막혔을 때의 안내. block_reason 텍스트로 판별한다. */
export function officeHint(reason: string | null | undefined): { title: string; body: string } | null {
  if (!reason) return null
  if (/Group Containers/.test(reason) && /not permitted|권한/i.test(reason)) {
    return {
      title: 'macOS가 Office 데이터 폴더 접근을 막았어요',
      body: '시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더(또는 앱 데이터 접근)에서 이 앱을 허용한 뒤 다시 실행하세요. 처음 실행 때 나온 "다른 앱의 데이터에 접근" 창을 허용해도 돼요.'
    }
  }
  if (/시간 초과|timed? ?out/i.test(reason)) {
    return {
      title: 'Word/Excel이 응답을 기다리다 시간이 지났어요',
      body: 'Word/Excel 창에 권한이나 파일 접근을 묻는 창이 떠 있으면 허용을 누른 뒤 다시 실행하세요. 앱은 자동으로 대신 누르지 않아요.'
    }
  }
  return null
}

export const HELPER = {
  button: 'AI 도우미 열기',
  notInstalledTitle: 'Claude Code가 아직 없어요',
  notInstalledBody: '논문을 쓰는 AI 도우미(Claude Code)를 먼저 설치해야 해요. 설치 후 이 버튼을 다시 누르면 앱이 규칙집을 넣고 도우미를 켜 줘요.',
  installGuide: '설치 안내 열기',
  chooseTitle: '어떤 도우미를 열까요?',
  chooseBody: '둘 다 설치돼 있어요. 처음이면 Claude Code를 권해요.',
  launchedTitle: '터미널 창에서 AI 도우미가 열렸어요',
  launchedBody: '처음이면 브라우저에 Claude 로그인 창이 떠요. 인터뷰 답변은 그 터미널 창에서 해요. 도우미가 저장할 때마다 이 앱을 새로고침하면 결과가 보여요.',
  skillInstalled: '규칙집을 설치했어요',
  skillUpdated: '규칙집을 새 버전으로 바꿨어요(이전 버전은 백업)',
  skillUnchanged: '규칙집은 이미 최신이에요'
}
