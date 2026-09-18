import type { ReactNode } from 'react'

export function Toolbar({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="toolbar">
      <h1>{title}</h1>
      {sub && <div className="sub">{sub}</div>}
      {actions && <div className="actions">{actions}</div>}
    </header>
  )
}
