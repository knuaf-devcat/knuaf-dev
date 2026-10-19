/**
 * 기본 창 크기 — 순수 함수 (발주 QA 기본 창 크기).
 *
 * 시안 안쪽 창 크기 **1280×800** 을 기본으로 하되, 화면 **작업 영역**보다 크면 작업 영역에
 * 맞춰 줄인다: 가로는 `1280` 과 `작업영역 − 40` 중 작은 값, 세로는 `800` 과 `작업영역 − 40`
 * 중 작은 값. 윈도우 1366×768 노트북에서도 창이 화면 밖으로 나가지 않게 하려는 것이다
 * (작업 영역 1366×768 → 1280×728).
 *
 * `minWidth 900`·`minHeight 600` 은 창 옵션에 그대로 남는다 — 이 계산은 그 위에서 기본값만 정한다.
 * 값을 재는 곳(main)과 시험(Node 단위)이 같은 함수를 쓴다.
 */
export const DEFAULT_WINDOW = { width: 1280, height: 800 } as const
/** 작업 영역 가장자리에서 남기는 여백 — 창이 화면 밖으로 나가지 않게. */
export const WINDOW_MARGIN = 40

export function defaultWindowSize(workArea: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.min(DEFAULT_WINDOW.width, workArea.width - WINDOW_MARGIN),
    height: Math.min(DEFAULT_WINDOW.height, workArea.height - WINDOW_MARGIN)
  }
}
