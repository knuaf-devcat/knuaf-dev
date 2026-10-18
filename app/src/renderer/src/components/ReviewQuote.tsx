import { Icon } from './Icon'
import { REVIEW } from '../copy'
import type { ReviewQuote } from '../store/review'

/**
 * 발주 QA2-B · N-I03 — 종이에서 고른 문장을 입력칸 위 인용 칩으로 보여 준다.
 *
 * 자리는 **대화 칸(`Chat.tsx`)이 정한다** — `.chat-composer` 바로 위에 그린다. B 가 넘길 때의
 * 임시 이음매(`ReviewQuoteHost` 가 좌표를 재서 `document.body` 로 얹던 것)는 통합에서 지웠다.
 * 문구는 `copy.ts` 의 `REVIEW` 한 곳에 있다.
 */
export function ReviewQuoteChip({ quote, onRemove }: { quote: ReviewQuote; onRemove: () => void }) {
  return (
    <div className="review-chip" role="group" aria-label={REVIEW.quoteLabel}>
      <span className="review-chip-w">
        <small>{REVIEW.quoteLead(quote.sectionTitle)}</small>
        <span className="review-chip-t">{quote.text}</span>
      </span>
      <button type="button" className="review-chip-x" onClick={onRemove} title={REVIEW.removeQuote} aria-label={REVIEW.removeQuote}>
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}
