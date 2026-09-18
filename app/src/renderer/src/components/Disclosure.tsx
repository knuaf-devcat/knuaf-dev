import type { ReactNode } from 'react'
import { Icon } from './Icon'

export function Disclosure({ label = '고급', children, open }: { label?: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="disclosure" open={open}>
      <summary><Icon name="chevron" /> {label}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  )
}
