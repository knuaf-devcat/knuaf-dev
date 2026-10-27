/**
 * 기본 창 크기 — 순수 함수 (발주 QA 기본 창 크기).
 *
 * 기본은 세 칸이 들어가는 1440×800이다. 화면 작업 영역보다 크면 각 방향에서
 * 작업 영역 − 40px로 줄인다. 작은 화면에서는 프로젝트 목록이 먼저 서랍으로 접힌다.
 *
 * `minWidth 900`·`minHeight 600` 은 창 옵션에 그대로 남는다 — 이 계산은 그 위에서 기본값만 정한다.
 * 값을 재는 곳(main)과 시험(Node 단위)이 같은 함수를 쓴다.
 */
export const DEFAULT_WINDOW = { width: 1440, height: 800 } as const
/** 작업 영역 가장자리에서 남기는 여백 — 창이 화면 밖으로 나가지 않게. */
export const WINDOW_MARGIN = 40

export function defaultWindowSize(workArea: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.min(DEFAULT_WINDOW.width, workArea.width - WINDOW_MARGIN),
    height: Math.min(DEFAULT_WINDOW.height, workArea.height - WINDOW_MARGIN)
  }
}
