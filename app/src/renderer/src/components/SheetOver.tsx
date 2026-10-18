import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { CLOSE_LABEL } from '../copy'

/**
 * 논문 칸을 덮는 한 장 (시안 ⑫, DESIGN §1-1 "마감 ⑫: 오른쪽을 제출 전 점검 한 장이 덮음").
 *
 * 시트(dialog)와 다르다: 창 전체가 아니라 **논문 칸 자리**를 덮는다. 논문 칸이 화면에 없을
 * 때(한 칸·좁은 창의 대화)는 셸이 창 전체를 덮는 시트로 같은 내용을 연다 — 어느 쪽이든
 * 내용(점검 행 네 개)은 한 벌이다.
 */
export function SheetOver({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!open) return null
  return (
    <div className="sheetover" role="dialog" aria-label={title}>
      <div className="sheetover-head">
        <h2>{title}</h2>
        <button className="quiet" aria-label={CLOSE_LABEL} onClick={onClose}><Icon name="x" /></button>
      </div>
      <div className="sheetover-body">{children}</div>
    </div>
  )
}
