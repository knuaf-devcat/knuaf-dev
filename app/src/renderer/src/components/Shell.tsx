import type { ReactNode } from 'react'
import { ProjectSidebar } from './ProjectSidebar'

/**
 * 앱 틀 — 제목줄 · 작업 공간 · 시트가 한 세로 줄기에 앉는다 (DESIGN §1-1).
 *
 * v4의 왼쪽 사이드바(`.layout` 격자)가 사라졌다. 이제 창은 위에서 아래로
 * **제목줄 → 작업 공간(대화 | 내 논문)** 이고, 시트는 그 위에 덮인다.
 *
 * `.drag-strip` 은 창을 끌 수 있는 띠다 — macOS는 신호등 자리를 비우고, 다른 OS는
 * 제목줄 단추가 그 안에 들어가므로 `main/index.ts`의 창 설정과 함께 맞춘다(별도 작업
 * feat/gui-v5-hidden 합류 뒤).
 */
export function Shell({ titleBar, children, sheets }: { titleBar: ReactNode; children: ReactNode; sheets?: ReactNode }) {
  return (
    <div className="app">
      <div className="drag-strip" aria-hidden="true" />
      {titleBar}
      <main className="stage"><ProjectSidebar />{children}</main>
      {sheets}
    </div>
  )
}
