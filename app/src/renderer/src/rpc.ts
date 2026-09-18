import type { Envelope, HistoryRow, LockInfo, RpcError, RpcResult, SectionRow, Status } from '../../shared/types'

export type EventHandler = (event: string, data: unknown) => void

export class RpcFailure extends Error {
  code: string
  data?: unknown
  constructor(err: RpcError) { super(err.message); this.code = err.code; this.data = err.data }
}

async function call<T>(method: string, params: Record<string, unknown> = {}, onEvent?: EventHandler): Promise<T> {
  const r: RpcResult<T> = await window.knuaf.call(method, params, onEvent)
  if (r.error) throw new RpcFailure(r.error)
  return r.result as T
}

export const rpc = {
  call,
  status: (root: string) => call<Status>('project.status', { root }),
  checks: (root: string, scope: 'all' | 'submission' = 'all') => call<Status['checks']>('project.checks', { root, scope }),
  sections: (root: string) => call<SectionRow[]>('project.sections', { root }),
  readSection: (root: string, id: string) => call<{ id: string; title: string; path: string; draft: string }>('section.read', { root, id }),
  export: (root: string, kind: string) => call<{ path: string; kind: string }>('project.export', { root, kind }),
  history: (root: string) => call<HistoryRow[]>('project.history', { root }),
  restore: (root: string, revision: number, expected_revision: number) => call<{ revision: number; restored_from: number; pre_restore_snapshot: string; notice: string }>('project.restore', { root, revision, expected_revision }),
  lockInfo: (root: string) => call<LockInfo>('lock.info', { root }),
  unlock: (root: string) => call<{ released: boolean; owner: unknown; leftover: string | null; notice?: string }>('lock.unlock', { root }),
  doctor: (root: string) => call<Record<string, any>>('doctor.all', { root }),
  buildTree: (root: string) => call<any>('fs.build_tree', { root }),
  init: (root: string) => call<{ project: unknown }>('project.init', { root }),
  script: (method: string, params: Record<string, unknown>, onEvent?: EventHandler) => call<Envelope>(method, params, onEvent)
}

/** Human wording for error codes; the raw message is always shown too. */
export function describeError(e: unknown): string {
  if (e instanceof RpcFailure) {
    const prefix: Record<string, string> = {
      lock_held: '다른 작업이 폴더를 잠그고 있어요. "문제 해결"에서 잠금 상태를 확인하세요.',
      revision_stale: '정본이 그사이 바뀌었어요. 새로고침 후 다시 시도하세요.',
      overwrite_refused: '이미 같은 이름의 산출물이 있어 덮어쓰지 않았어요. 새 경로를 쓰세요.',
      deps_not_ready: '이 작업에 필요한 Python 패키지가 아직 준비되지 않았어요. "문제 해결"에서 준비하세요.',
      sidecar_down: 'Python 실행기가 꺼져 있어요. 설정에서 다시 시작하세요.',
      timeout: '시간 안에 끝나지 않아 중단했어요.',
      cancelled: '취소했어요.'
    }
    return (prefix[e.code] ? prefix[e.code] + ' ' : '') + `(${e.code}) ${e.message}`
  }
  return String(e)
}
