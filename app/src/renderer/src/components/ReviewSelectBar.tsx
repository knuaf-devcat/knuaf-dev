import { REVIEW } from '../copy'

/**
 * 발주 QA2-B · N-I03 — 종이에서 문장을 고르면 선택 위에 뜨는 작은 행동 막대.
 *
 * `고쳐 달라기`는 고른 문장을 인용 칩으로 붙이고, `복사`는 클립보드를 쓴다. 막대 자신을
 * 누를 때 선택이 풀리지 않게 `onMouseDown` 을 막는다 — 그래야 누른 뒤에도 무엇을 골랐는지가
 * 화면에 남는다. 자리는 종이 칸(`.paperpane`, `position: relative`) 안 절대좌표다.
 */
export function ReviewSelectBar({ x, top, bottom, paneWidth, onQuote, onCopy }: {
  x: number
  /** 선택 위쪽 모서리 — 막대를 이 위에 얹는다. */
  top: number
  /** 선택 아래쪽 모서리 — 위가 좁으면 아래로 뒤집는다. */
  bottom: number
  paneWidth: number
  onQuote: () => void
  onCopy: () => void
}) {
  const below = top < 56
  const left = Math.max(84, Math.min(Math.max(paneWidth - 84, 84), x))
  return (
    <div className="selbar" data-below={below || undefined} style={{ left: `${left}px`, top: `${below ? bottom + 8 : top}px` }}
      onMouseDown={(e) => e.preventDefault()}>
      <button type="button" onClick={onQuote}>{REVIEW.quote}</button>
      <button type="button" onClick={onCopy}>{REVIEW.copy}</button>
    </div>
  )
}
