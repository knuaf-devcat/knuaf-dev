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
export interface Settings { recent: string[]; credit_shown_at: string | null; python_override: string | null }
