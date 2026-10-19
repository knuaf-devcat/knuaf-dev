import { create } from 'zustand'

/**
 * 폴더 준비(`deps.ensure`) 중인가 — 대화 전송과 화면이 함께 본다.
 *
 * 왜 따로 두나(형님 윈도우 실기 2026-10-19): 새 폴더를 열면 앱이 그 폴더의 `.venv` 를 뒤에서
 * 조용히 준비한다(`store/project.ts` `prepareDeps`). 윈도우에서는 몇 분 걸린다. 그 사이 학생이
 * "새로 시작하기"를 누르면 main 이 쓰기 작업 중이라 전송을 거절했고("앱이 저장·검사 작업 중이에요"),
 * 그 빨간 알림은 준비가 끝나도 남아 얼마나 기다려야 할지 알 수 없었다. 이제 전송은 준비가
 * 끝날 때까지 **기다렸다가** 보내고(`store/chat.ts` `send`), 그동안 화면은 진행 표시를 띄운다.
 *
 * project·chat 두 저장소가 서로를 부르지 않게 이 작은 저장소 하나를 둘이 같이 쓴다.
 */
/** 기다리는 이유 — 폴더 준비(.venv)인가, 앱의 저장·검사 작업인가. 화면 문구만 다르다. */
export type PrepKind = 'prep' | 'write'

interface PrepState {
  /**
   * 폴더별·종류별 진행 중인 작업 수. 같은 폴더의 작업이 겹칠 수 있다(폴더를 다시 열면 `prepareDeps` 가
   * 또 돈다) — 하나가 먼저 끝나도 다른 하나가 남아 있으면 아직 기다린다(검토 WINFB-R1-01 보조).
   */
  prep: Record<string, number>
  write: Record<string, number>
  begin: (root: string, kind?: PrepKind) => void
  end: (root: string, kind?: PrepKind) => void
}

const bump = (m: Record<string, number>, root: string, by: number): Record<string, number> => {
  const next = { ...m }
  const n = (m[root] ?? 0) + by
  if (n > 0) next[root] = n
  else delete next[root]
  return next
}

export const usePrep = create<PrepState>((set) => ({
  prep: {},
  write: {},
  begin: (root, kind = 'prep') => set((s) => ({ [kind]: bump(s[kind], root, 1) }) as Partial<PrepState>),
  end: (root, kind = 'prep') => set((s) => ({ [kind]: bump(s[kind], root, -1) }) as Partial<PrepState>)
}))

/** `root` 에서 지금 무엇을 기다리는가 — 준비가 저장·검사보다 먼저 보인다. 없으면 null. */
export function waitKind(s: Pick<PrepState, 'prep' | 'write'>, root: string | null): PrepKind | null {
  if (!root) return null
  if ((s.prep[root] ?? 0) > 0) return 'prep'
  if ((s.write[root] ?? 0) > 0) return 'write'
  return null
}

/** `root` 가 지금 준비·저장·검사 중인가 — 그동안 대화 전송은 기다린다. */
export const isPreparing = (root: string | null): boolean => waitKind(usePrep.getState(), root) !== null

/**
 * `root` 의 작업이 모두 끝나면 true, 그 전에 `leave()` 가 참이 되면(학생이 다른 대화로 떠남) false.
 * `watchLeave` 는 떠났는지 다시 볼 계기(대화 저장소의 구독)를 준다.
 */
export function waitPrepared(root: string, leave: () => boolean, watchLeave: (check: () => void) => () => void): Promise<boolean> {
  if (leave()) return Promise.resolve(false)
  if (!isPreparing(root)) return Promise.resolve(true)
  return new Promise((done) => {
    const finish = (ok: boolean): void => { offPrep(); offLeave(); done(ok) }
    const offPrep = usePrep.subscribe(() => { if (!isPreparing(root)) finish(true) })
    const offLeave = watchLeave(() => { if (leave()) finish(false) })
  })
}

/**
 * 사이드카의 쓰기 작업(`methods.list` 의 write) — main 은 이것이 도는 동안 대화 전송을 거절한다
 * (`service.ts` sidecarBusy). 렌더러가 시작한 쓰기의 **실제 시작·끝**에 `write` 대기를 묶는다(rpc.ts).
 * `deps.ensure` 는 폴더 열기 준비(`prep`)와 문제 해결의 "패키지 준비"(useRunner) 쪽이 따로 표시한다.
 */
export const WRITE_METHODS = new Set(['kordoc.ensure', 'lock.unlock', 'paper.generate', 'project.export', 'project.init', 'project.restore'])
