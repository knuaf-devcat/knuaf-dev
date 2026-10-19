import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icon'
import { CLOSE_LABEL } from '../copy'

/**
 * Modal surface: centered (confirm) or side (preview). Materialize motion via CSS; Esc/backdrop close.
 * `screen` 은 시험용 훅이다(`data-screen`) — 화면 이름이 곧 이 시트라는 것을 글자 대신 값으로
 * 잡는다. `Disclosure` 의 `data-preset` 과 같은 종류다(제목 글자가 바뀌어도 시험이 흔들리지 않는다).
 */
export function Sheet({ open, title, side, children, foot, onClose, badge, screen }: { open: boolean; title: ReactNode; side?: boolean; children: ReactNode; foot?: ReactNode; onClose: () => void; badge?: ReactNode; screen?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  // `close` 는 **자기 dialog 것만** 받는다. 안쪽 dialog(확인 창)가 닫힐 때 React 가 그 이벤트를
  // 바깥 dialog 의 핸들러로도 보내서, 확인 창을 닫으면 시트까지 함께 닫혔다(2026-10-18 실측:
  // TroubleShoot 의 잠금 해제 확인 → 설정 시트가 닫혀 완료 문구가 사라졌다). DOM 규칙대로도
  // close 는 bubbling 이 아니다 — target 을 확인하는 것이 맞다.
  return (
    <dialog ref={ref} className={`sheet ${side ? 'side' : ''}`} data-screen={screen} onClose={(e) => { if (e.target === ref.current) onClose() }} onClick={(e) => { if (e.target === ref.current) onClose() }}>
      <div className="sheet-head"><div className="row"><h2>{title}</h2>{badge}</div><button className="quiet" aria-label={CLOSE_LABEL} onClick={onClose}><Icon name="x" /></button></div>
      <div className="sheet-body">{children}</div>
      {foot && <div className="sheet-foot">{foot}</div>}
    </dialog>
  )
}
