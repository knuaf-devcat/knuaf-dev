/**
 * 파일 현재성 — **`project.load` 의 `outputs[*].stale` 만 본다**(v2 §4-1, DESIGN §2).
 * 기록 번호 비교는 금지다: 등록되지 않은 검토본은 `revision` 이 null 이라 번호로는
 * "같은지"를 판정할 수 없고, 판정할 수 없는 것을 "같다"고 말하면 안 된다.
 *
 * 순수 함수다 — 화면(파일 팝오버)과 Node 단위 시험이 같은 것을 쓴다.
 */
export interface OutputEntry { path?: string | null; revision?: number | null; stale?: boolean }
export interface LoadLike { project?: { outputs?: Record<string, OutputEntry | null> | null } | null }

export type FileState =
  /** 정본에 등록돼 있고 오래되지 않았다. */
  | 'same'
  /** 정본에 등록돼 있는데 `stale` 이다 — 고친 내용이 파일에 아직 없다. */
  | 'stale'
  /** 정본에 등록된 것이 없다 — 앱이 같은지 모른다. */
  | 'unknown'

/**
 * 검토본 export 가 내놓는 병합 본문 — `build/<개정>/review/검토용.md`.
 * **기준 개정도 이 경로에서 읽는다.** 진행 판정의 `reviewExport = max(N)`(어느 검토본이
 * 있나)과 파일 하나의 기준(이 파일이 몇 번째 기록 기준인가)은 다른 사실이다 — 옛 검토본에
 * 최신 N 을 붙이면 출처를 잘못 말한다(검토 P3-R1-03).
 */
export const REVIEW_BASIS = /(?:^|\/)build\/(\d+)\/review\/[^/]+$/

/** 검토본 파일인가 — 이 파일들은 `outputs` 에 등록되지 않고 개정 번호로만 말한다. */
export function isReviewExport(path: string): boolean {
  return REVIEW_BASIS.test(path)
}

/** 이 검토본이 기준으로 삼은 개정 N. 검토본 경로가 아니거나 번호를 못 읽으면 null. */
export function reviewBasisOf(path: string): number | null {
  const m = REVIEW_BASIS.exec(path)
  return m ? Number(m[1]) : null
}

/**
 * 파일 하나의 현재성. `outputs` 의 키는 출력 id 이고 경로는 값 안(`path`)에 있으므로
 * 둘 다로 찾는다 — 사이드카가 어느 쪽으로 적어 두었든 같은 답이 나온다.
 */
export function fileStateOf(path: string, load: LoadLike | null): FileState {
  const outputs = load?.project?.outputs ?? {}
  for (const [key, out] of Object.entries(outputs)) {
    if (key !== path && out?.path !== path) continue
    return out?.stale === true ? 'stale' : 'same'
  }
  return 'unknown'
}
