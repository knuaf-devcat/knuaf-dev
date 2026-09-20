import type { ReactNode } from 'react'
import { Icon } from './Icon'

export function Disclosure({ label = '고급', children, open, preset }: { label?: string; children: ReactNode; open?: boolean; preset?: string }) {
  return (
    <details className="disclosure" open={open} data-preset={preset}>
      <summary><Icon name="chevron" /> {label}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  )
}
