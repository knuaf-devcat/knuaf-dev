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
    action: '"설정 > 문제 해결"에서 잠금 상태를 확인해 주세요. 도우미가 저장 중이면 끝날 때까지 기다리면 돼요.',
    kind: 'warning'
  },
  lock_ambiguous: {
    title: '잠금 기록이 불명확해서 해제하지 않았어요.',
    action: '"설정 > 문제 해결"에서 잠금 정보를 보고, 다른 창에서 도우미가 이 폴더에 저장 중이 아닌지 확인해 주세요.',
    kind: 'warning'
  },
  revision_stale: {
    title: '논문이 그사이 바뀌었어요.',
    action: '"새로고침"을 누른 뒤 다시 시도해 주세요.',
    kind: 'warning'
  },
  overwrite_refused: {
    title: '같은 이름의 파일이 이미 있어 덮어쓰지 않았어요.',
    // 화면에 없는 조작을 시키지 않는다. "새 버전 경로" 버튼은 렌더러 어디에도 없었다(GUI-07).
    // 거절은 실패가 아니라 "이미 있다"는 사실이므로, 있는 곳과 다시 만드는 조건을 말한다.
    action: '그 파일은 아래 목록에 이미 있어요 — 거기서 열어 보세요. 새로 만들려면 논문을 고쳐 다음 기록이 된 뒤에 다시 눌러 주세요.',
    kind: 'warning'
  },
  business_rule: {
    title: '지금 상태에서는 할 수 없는 작업이에요.',
    action: '아래 설명을 확인해 주세요. 필요하면 내 논문에서 도우미에게 알려 주세요.',
    kind: 'error'
  },
  deps_not_ready: {
    title: '작업 준비가 아직 끝나지 않았어요.',
    action: '준비 작업을 자동으로 다시 시도해요. 계속되면 "설정 > 문제 해결"에서 확인해 주세요.',
    kind: 'warning'
  },
  not_found: {
    title: '파일이나 폴더를 찾지 못했어요.',
    action: '경로를 다시 확인하거나, "내 논문"에서 폴더를 다시 열어 주세요.',
    kind: 'error'
  },
  permission: {
    title: '파일을 읽거나 쓸 권한이 없어요.',
    action: '다른 프로그램에서 그 파일을 열어 두었다면 닫고, 폴더 권한을 확인한 뒤 다시 시도해 주세요.',
    kind: 'error'
  },
  timeout: {
    title: '시간 안에 끝나지 않아 멈췄어요.',
    action: '잠시 후 다시 시도해 주세요. 계속 반복되면 "설정 > Python 실행기"의 로그를 확인해 주세요.',
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
    action: '"설정 > Python 실행기"에서 실행기를 다시 시작해 주세요.',
    kind: 'error'
  },
  internal: {
    title: '예상하지 못한 문제가 생겼어요.',
    action: '"설정 > Python 실행기"의 로그를 확인하고, 반복되면 내 논문에서 도우미에게 알려 주세요.',
    kind: 'error'
  },
  // main process (sidecar.ts / ipc.ts)
  sidecar_down: {
    title: 'Python 실행기가 꺼져 있어요.',
    action: '"설정 > Python 실행기"에서 "적용·재시작"을 눌러 주세요.',
    kind: 'error'
  },
  sidecar_exited: {
    title: 'Python 실행기가 도중에 종료됐어요.',
    action: '"설정 > Python 실행기"에서 실행기를 다시 시작한 뒤, 하던 작업을 다시 실행해 주세요.',
    kind: 'error'
  },
  spawn_failed: {
    title: 'Python 실행기를 시작하지 못했어요.',
    action: '"설정 > Python 실행기"에서 Python 실행기 경로를 확인해 주세요. 비워 두면 자동으로 골라요.',
    kind: 'error'
  },
  // sidecar __main__.py
  python_too_old: {
    title: 'Python 버전이 너무 낮아요. 3.10 이상이 필요해요.',
    action: '"설정 > Python 실행기"에서 더 최신 Python을 지정해 주세요.',
    kind: 'error'
  },
  scripts_missing: {
    title: '점검에 필요한 파일을 찾지 못했어요.',
    action: '앱을 다시 설치하거나, "설정 > Python 실행기"의 로그에 적힌 위치를 확인해 주세요.',
    kind: 'error'
  },
  // ipc.ts agent_busy gate: an agent chat run may be writing right now.
  agent_busy: {
    title: 'AI 도우미가 작업 중이에요.',
    action: '답변이 끝난 뒤 다시 시도해 주세요.',
    kind: 'warning'
  },
  default: {
    title: '문제가 생겼어요.',
    action: '아래 내용을 확인해 주세요. 반복되면 내 논문에서 도우미에게 알려 주세요.',
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

/**
 * Chat-specific: provider/app-server errors arrive as raw strings — often a JSON
 * envelope (`{"error":{"message":…}}`) or an English API message. `describeError`
 * expects `{code,message}`, so this maps the common provider shapes to Korean
 * title+action; the original string always survives in `raw` (자세히).
 */
export function describeChatError(raw: string): DescribedError {
  const trimmed = raw.trim()
  let inner = trimmed
  try {
    const p = JSON.parse(trimmed) as { error?: { message?: unknown }; message?: unknown }
    const m = p?.error?.message ?? p?.message
    if (typeof m === 'string') inner = m
  } catch { /* plain text, use as-is */ }
  const classified = providerCopy(inner)
  if (classified) return { ...classified, code: null, raw: trimmed }
  // Our own Korean one-liners stay the headline; machine noise gets the generic title.
  if (!/[{}\[\]"]/.test(trimmed) && trimmed.length <= 160) return { title: trimmed, action: null, kind: 'error', code: null, raw: trimmed }
  return { title: '도우미가 답변을 만들지 못했어요.', action: '다시 보내 보세요. 계속되면 "설정 > 문제 해결"을 확인해 주세요.', kind: 'error', code: null, raw: trimmed }
}

function providerCopy(text: string): ErrorCopy | null {
  if (/requires a newer version|update (the )?codex|unsupported model|unknown model|not supported/i.test(text))
    return { title: '도우미 프로그램을 업데이트해야 해요.', action: 'Codex를 최신 버전으로 올린 뒤 다시 보내 주세요.', kind: 'error' }
  if (/\b(401|403)\b|unauthori|forbidden|authenticat|not logged in|\blogin\b/i.test(text))
    return { title: 'AI 계정 연결을 확인해 주세요.', action: '내 논문 화면에서 ChatGPT 로그인을 다시 한 뒤 보내 주세요.', kind: 'warning' }
  if (/\b429\b|rate.?limit|quota|usage limit|insufficient/i.test(text))
    return { title: '도우미 요청 한도에 걸렸어요.', action: '잠시 기다렸다가 다시 보내 주세요.', kind: 'warning' }
  if (/\b5\d\d\b|overloaded|internal server|temporarily unavailable/i.test(text))
    return { title: '도우미 서비스가 잠시 불안정해요.', action: '잠시 후 다시 보내 주세요.', kind: 'warning' }
  if (/timed?\s*out|ETIMEDOUT|ECONN|network|fetch failed|socket hang/i.test(text))
    return { title: '네트워크 연결을 확인해 주세요.', action: '인터넷 연결을 확인한 뒤 다시 보내 주세요.', kind: 'warning' }
  return null
}

// ---------------------------------------------------------------------------
// Label maps
// ---------------------------------------------------------------------------

export const STATUS_LABEL: Record<string, string> = {
  pass: '통과',
  fail: '실패',
  blocked: '아직 확인 못 함',
  pending: '대기',
  not_configured: '미설정',
  needs_user: '내 답변 필요',
  needs_evidence: '근거 필요',
  ready: '진행 가능',
  empty: '비어 있음',
  drafting: '작성 중',
  review_ready: '초안 다 씀',
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
  skill: '자동',
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
  sections: '장',
  questions: '질문',
  tasks: '할 일',
  reviews: '검토',
  rules: '규칙',
  approvals: '승인',
  outputs: '결과물'
}

/** gg_core.unlock releases only a lock from this same host whose owner process is gone. */
export const LOCK_VERDICT_COPY: Record<string, { title: string; detail: string }> = {
  none: {
    title: '잠금 없음',
    detail: '지금은 아무도 이 폴더를 잠그고 있지 않아요. 해제할 것이 없어요.'
  },
  live: {
    title: '실행 중인 작업이 잠금을 쥐고 있어요',
    detail: '같은 기기의 작업이 아직 살아 있어요. 해제하면 그 작업의 저장이 깨질 수 있어 앱이 해제하지 않아요. 기다리거나 그 작업(도우미 창)을 확인해 주세요.'
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
    detail: '누가 잠갔는지 읽을 수 없거나 프로세스 상태를 판정할 수 없어요. 앱은 이런 잠금을 보존해요. 다른 창에서 저장 중이 아닌지 직접 확인한 뒤 도우미에게 알려 주세요.'
  }
}

/**
 * gg_core check_id → what the check is *about*, in 한국어.
 *
 * Deliberately status-neutral noun phrases, never a verdict: gg_core emits the same id with
 * `pass` and with `fail`/`blocked` (e.g. `structure` at gg_core.py:1623 is the value returned
 * when nothing is wrong; `professor_approval` at :2002 is `pass` if recorded else `blocked`).
 * A verdict in the title would contradict the status next to it — and contradict the one line
 * that must never waver, that the app does not judge the professor's approval.
 * The badge states the verdict; this only names the subject.
 *
 * Ids carrying a suffix are matched by prefix (`guideline_item:…`) via `checkLabel`.
 * An unknown id must not fall through to an English reason on screen — the caller shows the
 * fallback and keeps the raw reason in 자세히.
 */
export const CHECK_LABEL: Record<string, string> = {
  guideline_profile: '학교 지침 설정',
  guideline_runtime: '학교 지침 읽기',
  guideline_item: '학교 지침 항목 근거',
  output_profile: '최종 제출 형식 확정',
  output_docx: 'DOCX 파일과 원고 일치',
  output_xlsx: '엑셀 파일과 원고 일치',
  output_hwp: '한글 파일과 원고 일치',
  professor_approval: '교수님 승인 기록',
  coverage: '모든 장의 다른 사람 검토',
  fact_unreviewed: '사실의 근거 확인',
  review_content: '내용에 대한 다른 사람 검토',
  review_logic: '논리 검토',
  review_calculation: '계산 검토',
  review_docx: 'DOCX 파일 확인',
  review_xlsx: '엑셀 파일 확인',
  review_render: '실제 출력 확인',
  review_observation: '검토 기록 형식',
  independent_review: '다른 사람 검토 기록',
  structure: '등록 자료 일관성',
  // 원자료(출처)
  source_hash: '원자료 변경 여부',
  source_missing: '원자료 파일 존재',
  source_ref_missing: '근거 자료 참조 기록',
  source_revision: '근거 자료 버전 일치',
  source_claims_invalid: '원자료 기록 형식',
  // 사실·주장
  claim_missing: '주장과 원문 대조',
  claim_mismatch: '주장과 원문 일치(항목·값·단위·기간)',
  claim_review: '주장 적합성 검토',
  claim_location: '주장의 본문 위치',
  calculation: '계산 확인',
  // 본문·장
  section: '장 기록 일관성',
  draft_changed: '본문 수동 변경 여부',
  draft_claim: '본문 주장과 등록 사실 일치',
  draft_marker_extra: '표시 범위 밖 본문',
  content_incomplete: '본문 작성 여부',
  dependency_revision: '앞 장과의 버전 일치',
  // 학교 규칙·지침
  school_profile: '학교 규칙 등록',
  rule_source: '학교 규칙 원문·위치 근거',
  rule_na: '해당 없음 적용 근거',
  rule_coverage: '학교 요구사항 반영 확인',
  rule_location: '학교 규칙의 본문 위치',
  // 재무·문서
  body_finance_crosscheck: '본문 숫자와 재무 자료 대조',
  document_parse: '문서 읽기',
  output_superseded_by: '더 새로 만든 파일 존재 여부',
  view_invalid: '보기 파일 읽기',
  view_missing: '보기 파일 존재',
  view_edited: '보기 파일 수동 변경 여부'
}

/**
 * Shown when no label is known. Also status-neutral on purpose: a failing unknown id must not
 * be softened into "아직 확인이 끝나지 않았어요". The badge says what happened; 자세히 keeps
 * the raw reason.
 */
export const CHECK_LABEL_FALLBACK = '확인 항목'

/** Target names are internal too: `project`/`guidelines`/`user_finish` are not 한국어. */
export const CHECK_TARGET_LABEL: Record<string, string> = {
  project: '논문 전체',
  guidelines: '학교 지침',
  user_finish: '한글 마무리'
}

/** Exact id first, then the `prefix:` family, then the fallback. */
/** gg_core.user_finish_task_list — the student's own finishing work in 한글. */
export const USER_FINISH_LABEL: Record<string, string> = {
  font_shinmyeongjo: '글꼴 신명조 확인',
  margins: '여백 맞추기',
  page_numbers: '페이지 번호',
  hwp_convert: 'HWP로 저장 후 다시 열어 확인'
}

/**
 * 검사 id → 이름표. 한글 마무리 항목(font_shinmyeongjo·margins·page_numbers)은
 * gate 에도 검사로 올라오는데 CHECK_LABEL 에는 없어서 전부 폴백("확인 항목")으로
 * 떨어졌고, 같은 문자열이라 중복 제거에 뭉쳐 세 개가 하나로 보였다. 학생은
 * "글꼴 신명조 확인 · 여백 맞추기 · 페이지 번호"라고 들어야 한다. 이름표는
 * USER_FINISH_LABEL 이 이미 갖고 있으므로 거기서 가져온다(정의는 한 곳에).
 */
export function checkLabel(checkId: string): string {
  const base = checkId.split(':')[0]
  return CHECK_LABEL[checkId] ?? USER_FINISH_LABEL[checkId] ?? CHECK_LABEL[base] ?? USER_FINISH_LABEL[base] ?? CHECK_LABEL_FALLBACK
}

// ---------------------------------------------------------------------------
// Four lanes (SKILL.md:34 — never one checkmark)
// ---------------------------------------------------------------------------

export type LaneCopy = {
  id: 'machine' | 'content_review' | 'output_review' | 'professor'
  title: '자동 점검' | '다른 사람 검토' | '파일 확인' | '교수님 승인'
  description: string
  readyText?: string
  notReadyText?: string
}

export const LANE_COPY: LaneCopy[] = [
  {
    id: 'machine',
    title: '자동 점검',
    description: '파일 해시·사실·계산·장을 정본과 대조하는 자동 검사예요.',
    readyText: '자동 점검이 끝난 상태예요(교수 확인 전).',
    notReadyText: '아직 자동 점검이 끝나지 않았어요.'
  },
  {
    id: 'content_review',
    title: '다른 사람 검토',
    description: '작성자와 다른 검토자가 원문과 대조한 기록이에요.',
    readyText: '독립검토 기록이 있어요.',
    notReadyText: '아직 독립검토 기록이 없어요. 자동 점검 통과가 이를 대신하지 않아요.'
  },
  {
    id: 'output_review',
    title: '파일 확인',
    description: '만들어진 DOCX/XLSX 파일의 글꼴·재계산·렌더를 실제로 확인한 결과예요.',
    readyText: '학교 지침이 준비돼 있어요.',
    notReadyText: '학교 지침이 아직 준비되지 않았어요.'
  },
  {
    id: 'professor',
    title: '교수님 승인',
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
    title: '등록된 장이 없어요',
    body: '도우미가 장을 등록하면 여기 나타나요. 작문은 도우미와의 대화에서 진행해요.'
  },
  build_tree: {
    title: '아직 만든 파일이 없어요',
    body: '"검토본 만들기" 등을 실행하면 여기에 쌓여요.'
  },
  orphans: {
    title: '남은 임시 파일이 없어요',
    body: '저장 도중 끊긴 파일이 있으면 여기 나타나요. 다른 작성자의 것일 수 있어 앱이 지우지 않아요.'
  },
  snapshots: {
    title: '정본 스냅샷이 없어요',
    body: '도우미가 저장할 때마다 직전 정본이 남아요. 아직 저장 기록이 없어요.'
  },
  materials_files: {
    title: 'sources 폴더에 파일이 없어요',
    body: '도우미가 자료를 sources/에 넣거나, 아래에서 파일을 골라 답변에 붙여 보세요.'
  },
  artifacts: {
    title: '아직 결과물이 없어요',
    body: '도우미가 build 폴더에 파일을 만들면 여기에 나타나요.'
  }
}

// ---------------------------------------------------------------------------
// 점검 화면 (design/05-어휘교체표 §16, design/03-화면/05·06)
// ---------------------------------------------------------------------------

/**
 * The 점검 screen groups status into what the student must do, what is broken, and what is
 * still unconfirmed — then the four lanes, always separate, never a single done badge.
 * Section order is fixed (내가 해야 할 일 → 고칠 곳 → 아직 확인 못 한 것) regardless of
 * which is empty, so the page does not reshuffle under the student.
 */
export const CHECKUP = {
  title: '점검',
  todoTitle: '내가 해야 할 일',
  fixTitle: '고칠 곳',
  pendingTitle: '아직 확인 못 한 것',
  lanesTitle: '네 가지 확인 상태',
  countsCaption: '등록 현황',
  actAnswer: '답변하러 가기',
  actFix: '도우미에게 고쳐달라기',
  actNotify: '도우미에게 알리기',
  actHow: '방법 보기',
  details: '자세히',
  emptyTodo: '지금 내가 할 일이 없어요',
  emptyFix: '고칠 곳이 없어요',
  emptyPending: '미뤄 둔 것이 없어요',
  emptyAll: '지금 고칠 곳이나 기다리는 답변이 없어요',
  goto: '점검에서 확인',
  /** needs_user task card — the question text lives in the chat, not in the task row. */
  needsUserLine: '도우미가 답변을 기다리고 있어요',
  needsEvidenceLine: '근거가 아직 없는 항목이에요',
  /** Unknown task status — surfaced, not silently dropped (the filter keeps anything ≠ ready). */
  taskOtherLine: '확인이 필요한 일이 있어요',
  /** Sheet body for 한글 마무리 items: the fix happens in 한글, not here. */
  finishHowNote: '이 일은 한글 프로그램에서 직접 확인·고치는 일이에요. 끝내고 나면 도우미에게 알려 주세요.',
  passedTitle: (n: number) => `통과한 검사 ${n}건`,
  laneLines: {
    machineFail: (n: number) => `실패 ${n}건 있음 — 위 고칠 곳 참고`,
    machineBlocked: (n: number) => `아직 확인 못 한 ${n}건 있음`,
    machinePass: (n: number) => `통과 ${n}건`,
    reviewDone: '기록 있음',
    fileNoGuideline: '학교 지침 미설정',
    fileReady: '학교 지침 준비됨 — 만들어진 파일과 대조해요',
    fileNotReady: '학교 지침 준비 안 됨',
    fileNone: '만들어진 파일이 아직 없어요',
    profRecorded: '승인 기록이 등록돼 있어요 — 앱이 판정한 것은 아니에요',
    profNone: '기록 없음 — 앱이 판정하지 않아요'
  }
} as const

// ---------------------------------------------------------------------------
// Completion messages (shown after an action succeeds)
// ---------------------------------------------------------------------------

export const COMPLETION: Record<string, string> = {
  exported: '검토본을 만들었어요',
  docx_built: 'DOCX를 만들었어요',
  paper_generated: '논문 골격을 만들었어요',
  blank_created: '빈 사본을 만들었어요',
  filled: '값을 채웠어요',
  deps_ready: '작업 준비가 끝났어요',
  kordoc_ready: '문서 읽기 도구가 준비됐어요',
  unlocked: '잠금을 해제했어요',
  restored: '이전 정본을 새 개정으로 되돌렸어요',
  init_done: '빈 정본을 만들었어요',
  cancelled: '취소했어요'
}

// ---------------------------------------------------------------------------
// Screen intros, onboarding
// ---------------------------------------------------------------------------

/** Data boundary: the agent providers see the project; the app itself phones nowhere. */
export const PRIVACY_NOTE = 'AI 도우미를 연결하면 답변과 작업 폴더의 내용이 선택한 제공업체(OpenAI 또는 Anthropic)로 전송돼요. 앱 자체는 그 외 어디에도 자료를 보내지 않아요.'


// ---------------------------------------------------------------------------
// Fixed sentences (SKILL.md:8, :15, :24, :34; parser-setup.md:12)
// ---------------------------------------------------------------------------

/** SKILL.md:8 — shown once on first entry, never inside a document or author field. */
export const CREDIT = {
  line1: 'knuaf-doc · 창업논문 작성 도우미',
  line2: 'prod. 특용작물전공 24학번 김대욱 · 산업곤충전공 24학번 이준재'
} as const

/** parser-setup.md:12 — the only sentence said when Kordoc is actually installed. */
export const KORDOC_SENTENCE = '문서를 읽는 데 필요한 도구를 준비할게요. 처음 한 번은 시간이 조금 걸릴 수 있어요.'

export const NO_OVERWRITE_NOTE = '기존 파일은 덮어쓰지 않아요. 같은 이름이 있으면 새 이름을 골라 주세요.'

/** SKILL.md:15, :24 — nothing here counts as school submission or professor approval. */
export const NOT_APPROVAL_NOTE = '교수님 승인으로 표시되지 않아요. 자동 점검 통과와 승인은 별개예요.'

/** interview-ui.md — the chat transcript is the record; the app only shows. */
export const READ_ONLY_NOTE = '읽기 전용이에요. 수정은 도우미와의 대화에서 요청해 주세요.'

/** SKILL.md:34 — when no independent review exists, say so first, always. */
export const INDEPENDENT_REVIEW_MISSING = {
  title: '독립검토 미실행',
  body: '아직 독립검토 기록이 없어요. 자동 점검 통과가 이를 대신하지 않아요.'
} as const

// ---------------------------------------------------------------------------
// Form fields (Outputs screen)
// ---------------------------------------------------------------------------

export const FIELD_LABEL: Record<string, string> = {
  paper_input: '도우미가 만든 입력 파일',
  paper_out: '저장할 이름',
  docx_in: '통합 본문 파일',
  out_path: '저장할 이름',
  font: '글꼴',
  xl_source: '학교 양식 파일(원본)',
  xl_map: '원본 셀 지도',
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
  paper_input: '도우미가 만든 paper-input.json. 폴더 안 상대경로로 적어요.',
  paper_out: '기본값 build/검토전_본문.md. 같은 이름이 있으면 이 칸의 경로를 직접 바꿔요.',
  docx_in: 'gg_school_paper.py가 만든 본문 Markdown(build/검토전_본문.md).',
  out_path: '폴더 안 상대경로. 기존 파일은 덮어쓰지 않아요.',
  font: '기본 신명조. 최종 글꼴 확인은 한글에서 직접 해요.',
  xl_source: '학교가 준 예시 XLSX. 원본은 읽기만 하고 바꾸지 않아요.',
  xl_map: 'inspect가 만드는 source-map.json. 어느 셀이 입력칸인지 적혀 있어요.',
  xl_blank: 'clear가 만드는 사본(blank-v1.xlsx). 수식·병합·서식은 그대로예요.',
  xl_writemap: '도우미가 만든 gg-xlsx-fill-map JSON.',
  xl_values: '도우미가 만든 gg-xlsx-fill-values JSON.',
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

export const CHAT = {
  title: '내 논문',
  checking: '연결 확인 중…',
  statusFailTitle: '도우미 상태를 확인하지 못했어요',
  statusFailBody: '"다시 확인"을 눌러 주세요. 계속되면 "설정 > 문제 해결"을 확인해 주세요.',
  loginFor: (p: string) => (p === 'claude' ? 'Claude 로그인' : 'ChatGPT 로그인'),
  installGuide: '설치 안내',
  recheck: '다시 확인',
  me: '나',
  assistant: '도우미',
  sending: '전송 중',
  uncertain: '전송 여부 불확실',
  resend: '다시 보내기',
  runningBody: '도우미가 작업 중이에요. 끝날 때까지 기다리거나 중단할 수 있어요.',
  stop: '중단',
  allow: '허용',
  allowAlways: '이 폴더에서는 계속 허용',
  // 신뢰는 폴더 단위로 '켜'지지만 허용 범위는 폴더 밖까지다(claude.ts 의 trusted 분기는
  // 모든 도구를 통과시킨다). "이 폴더에서만"이라고만 적으면 학생은 영향 범위가 폴더
  // 안이라고 읽는다 — 켜지는 자리와 미치는 범위를 나눠 적는다.
  allowAlwaysHint: '이 논문 폴더로 작업하는 동안에는 폴더 밖을 건드리는 명령도 묻지 않아요. 설정에서 언제든 되돌릴 수 있어요.',
  deny: '거절',
  attach: '파일 첨부',
  attachHint: '파일을 고르거나 끌어 놓으면 경로가 답변 끝에 추가돼요.',
  // 단축키는 툴팁으로 — placeholder는 실제 기능만 말한다(05-어휘교체표 §10).
  placeholder: '답변을 입력하세요',
  placeholderHint: 'Enter 보내기 · Shift+Enter 줄바꿈',
  send: '보내기',
  emptyTitle: '아직 대화가 없어요',
  emptyBody: '도우미와 나눈 대화가 여기 쌓여요.',
  emptyBodyStart: '도우미가 질문하며 논문을 함께 써요.',
  /** 학생이 "중단"을 누른 경우 — 앱은 멀쩡하다. 실패가 아니라 취소다. */
  stoppedTitle: '중단했어요',
  stoppedBody: '여기까지 오간 대화는 그대로 남아 있어요. 마지막 답변이 도우미에게 닿았는지는 알 수 없어요.',
  interruptedTitle: '앱이 작업 도중 종료됐어요',
  interruptedBody: '마지막 답변이 도우미에게 닿았는지 확인할 수 없어요. 내용을 확인한 뒤 필요하면 다시 보내 주세요.',
  // 빈 대화 시작 버튼 — "시작하기"/"이어서 하기" 문자열을 학생 대신 보낸다(agent.ts firstPrompt와 같은 문자열).
  startNew: '새로 시작하기',
  resume: '쓰던 논문 이어하기',
  pickHelperTitle: '어느 도우미로 시작할까요?',
  pickHelperBody: '한 번 고르면 기억해요. 바꾸려면 설정에서 바꿀 수 있어요.',
  pickCodexTitle: 'ChatGPT 채팅으로 시작',
  pickCodexBody: '앱 안에서 대화해요. 진행 상황을 앱이 정확히 보여줘요.',
  pickClaudeTitle: 'Claude Code로 시작',
  // Claude 채팅 연결은 아직 실험 중 — 그 사실을 숨기지 않는다.
  pickClaudeBody: '앱 안에서 대화해요. 아직 실험 중인 연결 방식이에요.',
  claudeStart: 'Claude Code로 시작',
  needInstallTitle: '도우미 프로그램이 아직 설치되지 않았어요',
  needInstallBody: '설치 안내를 따라 설치한 뒤 "다시 확인"을 눌러 주세요.',
  needLoginTitleFor: (p: string) => `${p === 'claude' ? 'Claude' : 'ChatGPT'} 로그인이 필요해요`,
  needLoginBody: '로그인이 끝나면 자동으로 연결돼요.',
  // 지금 상태 한 줄 — 행동 단위 사실만, 진척 암시·N/M 금지(02-내-논문-대화-중 결정).
  statusDrafting: (t: string) => `${t} 작성 중`,
  statusFix: (n: number) => `고칠 곳 ${n}개`,
  statusWait: (n: number) => `내 답변 ${n}건 기다리는 중`,
  activityTitle: '방금 한 일',
  activityBusy: '도우미 작업 중',
  activitySections: (n: number) => `장 ${n}개 등록`,
  activityFile: (name: string) => `최근 파일 ${name}`,
  activityFix: (n: number) => `자동 점검 고칠 곳 ${n}건 — 점검에서 확인할 수 있어요`,
  noFolderTitle: '논문 작업 폴더를 골라 주세요',
  noFolderIntro: '새 빈 폴더도 괜찮고, 이미 쓰던 폴더도 괜찮아요. 고른 폴더에 도우미용 파일이 자동으로 준비돼요.',
  noFolderBody: '폴더를 끌어다 놓아도 돼요.',
  openFolder: '폴더 열기…',
  opening: '여는 중…',
  prepFailedTitle: '준비 중 문제가 생겼어요',
  draftCopyTitle: '도우미에게 보낼 요청',
  draftCopyHintWait: '도우미가 연결되면 여기에서 바로 보낼 수 있어요. 지금은 복사해 둘 수 있어요.',
  draftCopy: '복사',
  draftCopied: '복사했어요',
}

export const MATERIALS = {
  title: '자료',
  currentTitle: '현재 작성물',
  manuscriptLabel: '현재 원고',
  financeLabel: '재무 파일',
  notDecided: '아직 정해지지 않았어요',
  currentCaption: '인터뷰에서 도우미가 정해요',
  answerStates: {
    provided: '제공됨',
    explicit_none: '없음으로 답함',
    not_applicable: '해당 없음',
    withheld: '답하지 않기로 함',
    unknown: '모름',
    not_provided: '아직 답 없음'
  } as Record<string, string>,
  refTitle: '참고자료',
  roleCurrent: '현재 작성물',
  addTitle: '파일 추가',
  addCaption: '고른 파일은 내 논문 답변 끝에 붙어요. 넣는 것만으로 현재 작성물이 되지는 않아요 — 도우미가 인터뷰에서 확인해요.',
  attach: '파일 고르기…',
  attachToChat: '답변에 첨부',
  dropLine: '여기에 파일을 놓거나',
  checkLinePre: '자료의 검사 상태는',
  checkLinePost: '에서 볼 수 있어요',
  checkLink: '점검'
}

export const ARTIFACTS = {
  title: '결과물',
  save: '다른 이름으로 저장…',
  reveal: '폴더에서 보기',
  openExternal: '원래 앱으로 열기',
  refresh: '새로고침',
  checkPass: '자동 점검 통과',
  checkFail: '자동 점검 실패',
  checkNone: '자동 점검 기록 없음',
  savedTo: '저장했어요',
  previewTitle: '미리보기',
  // 파일 만들기 — 목록 위 한 단, 버튼만(경로 입력 0). 비활성은 "입력이 없어 실행 자체가
  // 불가능한 경우"뿐이고 이유를 캡션으로 말한다(04-결과물 결정). 제출용 버튼은 게이트가
  // 막혀 있어도 활성 — 누르는 순간이 고지의 자리다(Q1·#4 기각).
  make: {
    title: '파일 만들기',
    review: '검토본 만들기',
    reviewBody: '지금 원고를 검토용 파일로 묶어요',
    docx: '논문 DOCX 만들기',
    docxBody: '도우미가 만든 본문을 논문 양식으로 묶어요',
    docxNoInput: '도우미가 아직 본문을 준비하지 않았어요. 채팅에서 요청해 주세요',
    submit: '제출용 파일 만들기',
    submitBody: '학교 제출용 후보를 만들어요 — 누르면 검토 상태를 먼저 알려줘요',
    xlsx: '재무 엑셀 만들기',
    xlsxBody: '단계가 여럿이라 "설정 > 고급 도구"의 재무 엑셀에서 진행해요',
    xlsxNoInput: '도우미가 재무 값을 아직 준비하지 않았어요',
    gateBlocked: '제출용 파일을 만들 수 없어요. 먼저 필요한 것',
    gateDetails: '자세히',
    advancedOpen: '고급 도구에서 직접 실행',
    xlsxGoto: '고급 도구에서 이어서 만들기',
    madeTitle: '만들어진 파일'
  }
}

export const PREVIEW = {
  pageOf: (n: number, total: number) => `${n}/${total} 페이지`,
  prev: '이전',
  next: '다음',
  docxPdfCaption: '원문 DOCX를 Word로 렌더한 PDF예요. DOCX 원본과 다를 수 있어요.',
  docxNoPdfTitle: '이 DOCX의 PDF가 아직 없어요',
  docxNoPdfBody: 'Word로 렌더해 PDF를 만들면 여기에서 미리 볼 수 있어요. 컴퓨터에 Microsoft Word가 있어야 해요.',
  docxRender: 'Word로 PDF 만들기',
  docxRendering: 'Word로 렌더하는 중…',
  uncalculatedTitle: '실제 Excel 재계산이 아직 안 됐어요',
  uncalculatedBody: '수식이 많은데 저장된 계산 값이 비어 있어요. Office 렌더 후 실제 값이 달라질 수 있어요.',
  truncated: '일부만 표시해요',
  empty: '비어 있는 파일이에요',
  unavailable: '이 형식은 미리보기를 지원하지 않아요.',
  loadFailed: '미리보기를 불러오지 못했어요.'
}

export const NAV = {
  thesis: '내 논문',
  materials: '자료',
  artifacts: '결과물',
  checkup: '점검',
  settings: '설정',
  tocHead: '논문 차례',
  tocNone: '아직 없음',
  savedNth: (n: number) => `${n}번째 기록` // revision은 apply마다 오른다 — 학생의 저장 행위만이 아님(gg_core.py:872)
}

/**
 * 설정 (03-화면/08) — 폴더 / 도우미 연결 / 문제 해결 / 고급 도구 / Python 실행기 / 앱 정보.
 * 문제 해결·고급 도구는 평소 닫힌 펼침 목록; 실패 경로의 딥링크가 해당 펼침을 연 채로 진입한다.
 */
export const SETTINGS = {
  title: '설정',
  folderTitle: '폴더',
  folderOpenOther: '다른 폴더 열기…',
  folderRecentClear: '목록 지우기',
  /** 유일한 경로 입력칸 — 평소엔 접혀 있고 일반 동선(선택 대화상자·드롭·최근 카드)에는 없다. */
  trustedTitle: '묻지 않기로 한 폴더',
  trustedBody: '이 폴더들에서는 도우미가 명령을 실행할 때 확인을 묻지 않아요. 언제든 해제할 수 있어요.',
  trustedOff: '해제',
  folderAdvanced: '고급 — 경로로 열기',
  folderPathLabel: '폴더 경로',
  folderPathOpen: '경로로 열기',
  // GUI-04 — 열기 실패를 알릴 때 지금 폴더가 어떻게 됐는지를 같이 말한다.
  folderKeptAfterFail: (name: string) => `"${name}" 폴더는 그대로 열려 있어요.`,
  folderNoneAfterFail: '아직 열려 있는 폴더가 없어요.',
  helperTitle: '도우미 연결',
  helperChatWhich: '어느 도우미와 채팅할까요?',
  helperChatCodex: 'ChatGPT (Codex)',
  helperChatClaude: 'Claude Code — 실험 중',
  helperChatNote: 'Claude Code 채팅은 아직 실험 중이에요. 막히면 아래 "앱 밖 터미널로 도우미 열기"로 같은 도우미를 직접 띄울 수 있어요.',
  troubleTitle: '문제 해결',
  toolsTitle: '고급 도구',
  toolsNote: '직접 실행 — 평소엔 필요 없어요',
  pythonTitle: 'Python 실행기',
  appInfoTitle: '앱 정보'
}

export const HELPER = {
  button: '앱 밖 터미널로 도우미 열기',
  notInstalledTitle: 'Claude Code가 아직 없어요',
  notInstalledBody: '논문을 쓰는 AI 도우미(Claude Code)를 먼저 설치해야 해요. 설치 후 이 버튼을 다시 누르면 앱이 규칙집을 넣고 도우미를 켜 줘요.',
  installGuide: '설치 안내 열기',
  chooseBody: '둘 다 설치돼 있어요. 어느 쪽을 열지 골라 주세요.',
  launchedTitle: '터미널 창에서 AI 도우미가 열렸어요',
  launchedBody: '처음이면 브라우저에 Claude 로그인 창이 떠요. 인터뷰 답변은 그 터미널 창에서 해요. 도우미가 저장할 때마다 이 앱을 새로고침하면 결과가 보여요.',
}
