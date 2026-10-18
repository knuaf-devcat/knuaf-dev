/**
 * 두 칸 배치 — 순수 함수 (IMPL-PLAN §4-2).
 *
 * 배치 상태는 **저장하지 않고 매번 계산한다.** 학생이 직접 고른 것 하나(`paperClosed`)만
 * 설정에 남는다. 화면 조각마다 폭 조건을 흩어 놓으면 경계가 두 곳에서 어긋나므로
 * 여기 한 곳이 정하고, e2e 가 `setSize` 로 그 위를 한 번 밟는다(Node 단위 시험은
 * `e2e/layout.spec.ts` 가 1,139/1,140/1,219/1,220 을 고정한다).
 *
 * 폭 규칙(검토 IMPL-R1-06): 종이 칸 최소 680px(종이 600 + 좌우 여백 40씩), 대화 칸은
 * 460~540px 사이에서 줄어든다. 칸 사이 경계선은 종이 칸 안쪽 1px 테두리라 폭에 더하지
 * 않는다.
 */

/** 종이 칸 최소 폭 — 종이 600 + 좌우 여백 40씩. */
export const PAPER_MIN = 680
/** 대화 칸 최소 폭. */
export const CHAT_MIN = 460
/** 대화 칸 최대 폭 — 이보다 넓어지면 종이가 더 가져간다. */
export const CHAT_MAX = 540
/** 두 칸이 되는 최소 창 폭 = 대화 최소 + 종이 최소. */
export const WIDE_MIN = CHAT_MIN + PAPER_MIN

export type Layout =
  /** 아직 쓴 글이 없다 — 가운데 한 칸. 빈 종이로 진척을 연출하지 않는다. */
  | { kind: 'solo' }
  /** 넓은데 학생이 종이를 닫았다 — 한 칸 + 제목줄 [대화 | 내 논문]. 다시 저절로 열지 않는다. */
  | { kind: 'solo-with-toggle' }
  /** 두 칸: 대화(460~540) | 내 논문(나머지). */
  | { kind: 'split'; chatWidth: number }
  /** 좁은 창 — 한 칸 + 제목줄 [대화 | 내 논문]. */
  | { kind: 'switch' }

/**
 * 두 칸일 때의 대화 칸 폭 — `clamp(460, W − 680, 540)`.
 * 1,140~1,219px 에서는 460~539px 로 줄고, 1,220px 부터 540px 고정이다.
 */
export function chatWidthOf(width: number): number {
  return Math.min(CHAT_MAX, Math.max(CHAT_MIN, width - PAPER_MIN))
}

/**
 * 지금 배치. `width` 는 창 **내부** 폭(렌더러가 재는 값)이다.
 * `hasBody` 는 등록된 절 중 본문이 있는 것이 하나라도 있는지(`project.sections`).
 */
export function layoutOf({ hasBody, width, closed }: { hasBody: boolean; width: number; closed: boolean }): Layout {
  if (!hasBody) return { kind: 'solo' }
  if (width < WIDE_MIN) return { kind: 'switch' }
  return closed ? { kind: 'solo-with-toggle' } : { kind: 'split', chatWidth: chatWidthOf(width) }
}

/** 제목줄의 [대화 | 내 논문] 바꾸기가 쓰는 값 — `switch`·`solo-with-toggle` 에서 종이로 간다. */
export function showsToggle(layout: Layout): boolean {
  return layout.kind === 'switch' || layout.kind === 'solo-with-toggle'
}
