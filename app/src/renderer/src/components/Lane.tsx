import type { ReactNode } from 'react'

/** One of the four independent status lanes. Title string is rendered as "N. 제목" (e2e matches it). */
export function Lane({ number, title, badge, children, description, foot }: { number: string; title: string; badge?: ReactNode; children?: ReactNode; description?: ReactNode; foot?: ReactNode }) {
  return (
    <section className="card lane" aria-label={`${number} ${title}`}>
      <div className="t"><h2>{number} {title}</h2>{badge}</div>
      {children}
      {description && <div className="desc">{description}</div>}
      {foot && <div className="foot">{foot}</div>}
    </section>
  )
}
