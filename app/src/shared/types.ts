// Shared between main, preload and renderer.
export type RpcEvent = { event: string; data: unknown }
export type RpcError = { code: string; message: string; data?: unknown }
export type RpcResult<T = unknown> = { result?: T; error?: RpcError }

export interface CheckRow {
  check_id: string
  target: string
  status: 'pass' | 'fail' | 'blocked' | 'pending' | 'not_configured' | string
  severity: 'error' | 'warning' | string
  reason: string
  evidence: unknown[]
  owner: 'skill' | 'user' | 'professor' | string
  required_for: string[]
  input_revision: number
}

export interface LaneSummary { pass: number; fail: number; blocked: number; other: number; total: number }
export interface Lanes {
  machine: { summary: LaneSummary; ready: boolean }
  content_review: { summary: LaneSummary; by_kind: Record<string, string>; independent_review_missing: boolean }
  output_review: { summary: LaneSummary; guideline_ready: boolean | null }
  professor: { summary: LaneSummary; pending: boolean; recorded: boolean }
}
export interface UserFinishItem { id: string; status: string; owner: string; reason: string }
export interface TaskRow { id: string; status: string; missing?: string[]; owner?: string; reason?: string }
export interface Status {
  revision: number
  project_id: string | null
  checks: CheckRow[]
  gate: CheckRow[]
  completion: { skill_ready: boolean; guideline_ready: boolean | null; professor_approval_pending: boolean; notice: string; user_finish_pending: UserFinishItem[] }
  tasks: TaskRow[]
  lanes: Lanes
  user_finish_pending: UserFinishItem[]
  counts: Record<string, number>
}
export interface LockInfo {
  path: string; present: boolean; owner: Record<string, unknown> | null; owner_state: string; host: string
  host_matches: boolean | null; pid_alive: boolean | null; acquired_at: number | null; age_seconds: number | null
  verdict: 'none' | 'live' | 'stale_releasable' | 'foreign_host' | 'ambiguous'; notice: string
}
export interface HistoryRow { revision: number; hash: string; request_id: string | null; snapshot_path: string | null; snapshot_ok: boolean | null; current?: boolean }
export interface SectionRow { id: string; title: string; order: number; path: string; status: string; revision: number; draft_hash: string; draft_hash_ok: boolean; draft_chars?: number; claims: number | null; error?: string }
export interface Envelope {
  ok: boolean; exit: number; status: string | null; data: unknown; path: string | null; block_reason: string | null
  stdout: string; stderr: string; argv: string[]; python: string; duration_ms: number; venv_python?: string | null
}
export interface SidecarInfo { python: string; kind: 'env' | 'venv' | 'managed' | 'bundled' | 'path'; scriptsDir: string; running: boolean }
/**
 * `project:open` 의 응답. 시작 단계(사이드카 configure)에서 실패하면 **실패한 그 선택**의
 * python·kind 를 `sidecar` 로, `startupFailed: true` 를 같이 돌려준다(PY-D1-03).
 * renderer 는 이 값으로만 준비 버튼을 판단하고 store.sidecar(성공한 프로젝트)로 판단하지 않는다.
 */
export interface OpenProjectReply {
  result?: { root: string; hasProject: boolean; nestedProject?: string | null; sidecar: SidecarInfo }
  error?: RpcError
  sidecar?: SidecarInfo
  startupFailed?: boolean
}
export interface RecentEntry { root: string; opened_at: string }
/** `runtime:status` — 지원 플랫폼인지, 유효 설치가 있는지, 내려받기 크기(압축). */
export interface RuntimeStatus { supported: boolean; target: string | null; installed: boolean; sizeBytes: number | null }
/** `runtime:install` 의 응답 — 성공하면 새 선택으로 재시작한 사이드카 정보를 같이 준다. */
export interface RuntimeInstallReply { installed: boolean; sidecar: SidecarInfo }
export interface Settings {
  recent: RecentEntry[]
  credit_shown_at: string | null
  /**
   * 여는 화면을 띄울지. 기본은 띄운다 — 켤 때마다 본다.
   * 시험이 이것으로 끈다(스펙 90개가 저마다 2.6초를 더 기다릴 이유가 없다).
   */
  show_intro?: boolean
  python_override: string | null
  codex_terminal?: boolean
  /**
   * Which helper the student picked. 디스크에는 옛 'codex-term'/'claude-term'이 남아 있을
   * 수 있다 — loadSettings 의 migrateHelperMode 가 채팅 모드로 옮겨 주므로 런타임에는
   * 이 두 값만 존재한다(인앱 터미널은 제거됨, 외부 터미널 버튼은 유지).
   */
  helper_mode?: 'codex-chat' | 'claude-chat' | null
  /**
   * 학생이 **직접 고른** 대화 공급자. `helper_mode` 는 고른 적이 없어도 기본값이 채워지고
   * 저장되므로 선택의 증거가 아니다(IMPL-R1-02). 이 키가 있으면 대화 공급자는 이 값을
   * 따르고, 없으면(null) 고른 적이 없다는 뜻이라 첫 화면에서 한 번 고르게 한다.
   * 기존 사용자의 `helper_mode` 를 여기로 승격하지 않는다 — 그건 선택이 아니었다.
   */
  provider_choice?: { provider: 'codex' | 'claude'; at: string } | null
  /**
   * 첫 실행 화면(온보딩)을 지났음과 그 시각. **공급자 선택의 근거가 아니다** —
   * 시험이 온보딩을 건너뛰게 하는 표시로도 쓴다(e2e/helpers.ts).
   */
  onboarded_at?: string | null
  /**
   * 학생이 "이 폴더에서는 계속 허용"을 고른 작업폴더들(realpath·NFC 로 보관).
   * 판정할 수 없는 셸 명령(heredoc 으로 밀어 넣는 프로그램 등)은 어떤 허용 목록으로도
   * 안전을 증명할 수 없다. 읽을 수 없는 것을 반복해서 묻는 대신, 폴더 단위로 한 번
   * 정하고 설정에서 언제든 되돌린다. 다른 폴더로 옮겨가지 않는다.
   */
  trusted_roots?: string[]
  /**
   * 도구를 쓸 때마다 물을지 정하는 전역 기본값. **키가 없으면 'trust'**(묻지 않기)로 읽는다 —
   * 기존 사용자도 기본이 바뀐다. 읽지도 못할 명령을 매번 클릭하게 만드는 것은 동의를 구하는
   * 일이 아니라 습관을 만드는 일이고, 그러면 정작 폴더 밖을 건드리는 순간에도 허용을 누른다.
   * 'ask' 를 고르면 예전처럼 매번 묻는다. 마이그레이션은 하지 않는다 — 없을 때 'trust' 로
   * 읽는 것으로 충분하다. 폴더별 trusted_roots 는 이 값과 무관하게 그대로 살아 있다.
   */
  permission_mode?: 'trust' | 'ask'
  /**
   * 논문별 화면 취향. **학생이 직접 고른 것만** 저장한다(IMPL-PLAN §4-2) — 배치 자체
   * (한 칸/두 칸)는 저장하지 않고 매번 계산한다. 지금 담는 것은 종이 칸을 닫았는지 하나다.
   * 키는 앱이 폴더를 열 때 받은 경로 그대로다(렌더러에는 realpath 가 없다).
   */
  ui_prefs?: Record<string, { paperClosed?: boolean }>
}
/** Window chrome hints for the renderer (macOS vibrancy/inset title bar vs. overlay controls elsewhere). */
export interface WindowInfo { platform: string; vibrancy: boolean; titleBarInset: boolean; overlay: boolean }
/** Cheap look at `<root>/project.json` without starting the sidecar. */
export interface ProjectPeek { exists: boolean; hasProject: boolean; revision: number | null; project_id: string | null; mtime: number | null }

// --- materials.list / artifact.list / artifact.preview ----------------------

export interface MaterialFact { provided: boolean; path: string | null; value: string | null; note: string | null; answer_state: string | null }
export interface MaterialFile { path: string; bytes: number; mtime: number; role: 'current' | 'reference' }
export interface MaterialsData {
  current_manuscript: MaterialFact
  current_finance: MaterialFact
  reference_materials: MaterialFact
  work_basis: string | null
  files: MaterialFile[]
}

export type ArtifactKind = 'docx' | 'xlsx' | 'pdf' | 'md'
export interface ArtifactItem { path: string; name: string; kind: ArtifactKind; bytes: number; mtime: number; revision: number | null }
export interface XlsxSheet { name: string; max_row: number; max_col: number; rows: string[][]; truncated: boolean }
export type ArtifactPreview =
  | { kind: 'xlsx'; sheets: XlsxSheet[]; formulas: number; formulas_uncalculated?: boolean }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'pdf' }
  | { kind: 'unavailable'; reason: string }
