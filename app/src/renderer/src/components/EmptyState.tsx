import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export function EmptyState({ icon = 'circle', title, body, action }: { icon?: IconName; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={22} />
      <div className="t">{title}</div>
      {body && <div>{body}</div>}
      {action}
    </div>
  )
}
