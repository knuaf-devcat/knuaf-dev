import type { SectionRow } from '../../../shared/types'
import { layoutOf, showsToggle, type Layout } from '../../../shared/layout'
import { useProject } from '../store/project'

export { showsToggle }

/**
 * "본문이 있는 장이 하나라도 있는가" — 두 칸이 되는 조건(IMPL-PLAN §4-2).
 * `draft_chars` 를 못 받은 경우(사이드카가 모르는 상태)는 없는 것으로 본다 — 빈 종이를
 * 옆에 열어 진척을 연출하지 않는다는 규칙이 이쪽이 안전하다.
 */
export function hasBodyOf(sections: SectionRow[] | null): boolean {
  return !!sections?.some((s) => (s.draft_chars ?? 0) > 0)
}

/**
 * 지금 배치. **저장하지 않고 매번 계산한다**(IMPL-PLAN §4-2) — 입력은 셋뿐이다:
 * 등록된 절의 본문 유무, 창 내부 폭(ResizeObserver 가 store 에 채운다), 학생이 닫았는지.
 *
 * TitleBar 와 Workspace 가 같은 값을 봐야 해서 훅으로 둔다 — 둘이 각자 계산하면
 * 좁은 창에서 제목줄과 본문이 서로 다른 배치를 그린다.
 */
export function useLayout(): Layout {
  const sections = useProject((s) => s.sections)
  const width = useProject((s) => s.windowWidth)
  const closed = useProject((s) => s.paperClosed)
  return layoutOf({ hasBody: hasBodyOf(sections), width, closed })
}

/** 논문 칸이 지금 화면에 있는가 — 점검 한 장을 논문 칸에 덮을지 정한다(시안 ⑫). */
export function showsPaper(layout: Layout, paneView: 'chat' | 'paper'): boolean {
  return layout.kind === 'split' || (layout.kind === 'switch' && paneView === 'paper')
}

/** 대화 칸이 지금 화면에 있는가. */
export function showsChat(layout: Layout, paneView: 'chat' | 'paper'): boolean {
  return layout.kind !== 'switch' || paneView === 'chat'
}
