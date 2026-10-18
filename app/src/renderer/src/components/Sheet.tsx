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
  return (
    <dialog ref={ref} className={`sheet ${side ? 'side' : ''}`} data-screen={screen} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose() }}>
      <div className="sheet-head"><div className="row"><h2>{title}</h2>{badge}</div><button className="quiet" aria-label={CLOSE_LABEL} onClick={onClose}><Icon name="x" /></button></div>
      <div className="sheet-body">{children}</div>
      {foot && <div className="sheet-foot">{foot}</div>}
    </dialog>
  )
}
