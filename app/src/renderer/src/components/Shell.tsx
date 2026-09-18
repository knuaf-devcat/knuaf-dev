import type { ReactNode } from 'react'

export function Shell({ sidebar, children, screenKey }: { sidebar: ReactNode; children: ReactNode; screenKey: string }) {
  return (
    <div className="layout">
      <div className="drag-strip" aria-hidden="true" />
      {sidebar}
      <main className="main">
        <div className="main-inner screen-enter" key={screenKey}>{children}</div>
      </main>
    </div>
  )
}
