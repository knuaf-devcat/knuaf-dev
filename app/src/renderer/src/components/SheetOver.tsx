import { useEffect, type ReactNode } from 'react'
import { Icon } from './Icon'
import { CLOSE_LABEL } from '../copy'

/**
 * 논문 칸을 덮는 한 장 (시안 ⑫, DESIGN §1-1 "마감 ⑫: 오른쪽을 제출 전 점검 한 장이 덮음").
 *
 * 시트(dialog)와 다르다: 창 전체가 아니라 **논문 칸 자리**를 덮는다. 논문 칸이 화면에 없을
 * 때(한 칸·좁은 창의 대화)는 셸이 창 전체를 덮는 시트로 같은 내용을 연다 — 어느 쪽이든
 * 내용(점검 행 네 개)은 한 벌이다.
 */
export function SheetOver({ open, title, onClose, children, screen }: { open: boolean; title: string; onClose: () => void; children: ReactNode; screen?: string }) {
  // Esc 로 닫힌다 — `<dialog>`(자료·결과물·설정 시트)와 같은 규칙이다.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="sheetover" role="dialog" aria-label={title} data-screen={screen}>
      <div className="sheetover-head">
        <h2>{title}</h2>
        <button className="quiet" aria-label={CLOSE_LABEL} onClick={onClose}><Icon name="x" size={13} /> {CLOSE_LABEL}</button>
      </div>
      <div className="sheetover-body">{children}</div>
    </div>
  )
}
