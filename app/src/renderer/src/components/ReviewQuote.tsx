import { useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { installQuoteSendBridge, useReview, type ReviewQuote } from '../store/review'

/**
 * 발주 QA2-B · N-I03 — 종이에서 고른 문장을 입력칸 위 인용 칩으로 보여 준다.
 *
 * **문구는 여기 상수로 둔다.** 대화 칸(`Chat.tsx`)·`components.css`·`copy.ts` 는 A 워커 소유라
 * 건드리지 않았다 — 책임자가 A 에게 넘길 문구 목록은 `impl/REPORT-QA2-B.md` 에 있다.
 */
export const REVIEW = {
  quote: '고쳐 달라기',
  copy: '복사',
  diffToggle: '고친 부분 보기',
  diffToggleHint: '지운 문장과 새로 쓴 문장을 색으로 보여 줘요',
  quoteLead: (title: string): string => `${title}에서 고른 문장`,
  removeQuote: '인용 빼기',
  quoteLabel: '고른 문장'
} as const

/** 인용 칩 — 장 이름 + 문장 앞부분 + 빼기(×). 입력칸 위에 붙는다. */
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

/** 입력칸(`.chat-composer`) 바로 위에 뜨는 고정 자리 — 좌표는 그 상자에서 잰다. */
function useAboveComposer(active: boolean, zoneKey: string): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null)
  useEffect(() => {
    if (!active) { setStyle(null); return }
    const measure = (): void => {
      const box = document.querySelector('.chat-composer')
      if (!box) { setStyle(null); return }
      const r = box.getBoundingClientRect()
      // translateY(-100%) 로 칩을 상자 위에 얹는다(review.css).
      setStyle({ left: `${r.left}px`, width: `${r.width}px`, top: `${r.top - 8}px` })
    }
    measure()
    const box = document.querySelector('.chat-composer')
    const ro = new ResizeObserver(measure)
    if (box) ro.observe(box)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [active, zoneKey])
  return style
}

/**
 * 인용 칩의 임시 자리 — **A 워커가 `Chat.tsx` 의 `.chat-zone` 에 이 칩을 꽂으면 지운다**.
 * 그때까지는 종이 칸이 띄운 이 호스트가 입력칸 위에 fixed 로 얹는다(REPORT 의 한 줄 참고).
 * 좌표를 몰라도 되게 `document.body` 로 portal 한다 — 대화 칸 DOM 은 손대지 않는다.
 */
export function ReviewQuoteHost({ zoneKey }: { zoneKey: string }) {
  const quote = useReview((s) => s.quote)
  const clearQuote = useReview((s) => s.clearQuote)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const style = useAboveComposer(!!quote, zoneKey)
  // 인용이 붙어 있을 때 보내는 길을 한 겹 감싼다 — A 가 Chat.tsx 에 꽂으면 지운다.
  useEffect(() => { installQuoteSendBridge() }, [])
  useEffect(() => {
    const el = document.createElement('div')
    el.className = 'review-quote-fixed'
    document.body.appendChild(el)
    setHost(el)
    return () => { el.remove(); setHost(null) }
  }, [])
  if (!host || !quote || !style) return null
  return createPortal(
    <div className="review-quote-fixed-inner" style={style}>
      <ReviewQuoteChip quote={quote} onRemove={clearQuote} />
    </div>,
    host
  )
}
