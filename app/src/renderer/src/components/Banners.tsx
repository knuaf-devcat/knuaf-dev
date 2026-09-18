import type { Status } from '../../../shared/types'

/** cross-review.md:3 — when no valid independent review exists, say so first, always. */
export function IndependentReviewBanner({ status }: { status: Status }) {
  if (!status.lanes.content_review.independent_review_missing) return null
  return <div className="banner warn"><strong>독립검토 미실행</strong> — 작성자와 다른 검토자의 내용검토 기록이 아직 없습니다. 기계검사 통과는 내용검토를 대신하지 않습니다.</div>
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="banner bad">{error}</div>
}

/** SKILL.md:8 — shown once on first entry, never inside any document. */
export function CreditBanner() {
  return (
    <div className="credit">
      knuaf-doc · 창업논문 작성 도우미<br />prod. 특용작물전공 24학번 김대욱
    </div>
  )
}
