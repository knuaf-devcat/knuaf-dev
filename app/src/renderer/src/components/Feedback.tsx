import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export type FeedbackKind = 'status' | 'completion' | 'warning' | 'error'
const ICON: Record<FeedbackKind, IconName> = { status: 'info', completion: 'done', warning: 'warn', error: 'warn' }

/** The four feedback kinds (status / completion / warning / error). */
export function Feedback({ kind, title, body, actions, details }: { kind: FeedbackKind; title: ReactNode; body?: ReactNode; actions?: ReactNode; details?: ReactNode }) {
  return (
    <div className={`feedback ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon name={ICON[kind]} />
      <div>
        <div className="title">{title}</div>
        {body && <div className="body">{body}</div>}
      </div>
      {actions ? <div className="actions">{actions}</div> : <span />}
      {details && <details className="disclosure"><summary><Icon name="chevron" /> 자세히</summary><div className="disclosure-body">{details}</div></details>}
    </div>
  )
}
