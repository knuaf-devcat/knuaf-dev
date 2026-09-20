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
export interface SidecarInfo { python: string; kind: 'env' | 'venv' | 'bundled' | 'path'; scriptsDir: string; running: boolean }
export interface RecentEntry { root: string; opened_at: string }
export interface Settings {
  recent: RecentEntry[]
  credit_shown_at: string | null
  python_override: string | null
  codex_terminal?: boolean
  /**
   * Which helper the student picked. 디스크에는 옛 'codex-term'/'claude-term'이 남아 있을
   * 수 있다 — loadSettings 의 migrateHelperMode 가 채팅 모드로 옮겨 주므로 런타임에는
   * 이 두 값만 존재한다(인앱 터미널은 제거됨, 외부 터미널 버튼은 유지).
   */
  helper_mode?: 'codex-chat' | 'claude-chat' | null
  /**
   * 학생이 "이 폴더에서는 계속 허용"을 고른 작업폴더들(realpath·NFC 로 보관).
   * 판정할 수 없는 셸 명령(heredoc 으로 밀어 넣는 프로그램 등)은 어떤 허용 목록으로도
   * 안전을 증명할 수 없다. 읽을 수 없는 것을 반복해서 묻는 대신, 폴더 단위로 한 번
   * 정하고 설정에서 언제든 되돌린다. 다른 폴더로 옮겨가지 않는다.
   */
  trusted_roots?: string[]
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
