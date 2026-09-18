import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icon'

/** Modal surface: centered (confirm) or side (preview). Materialize motion via CSS; Esc/backdrop close. */
export function Sheet({ open, title, side, children, foot, onClose, badge }: { open: boolean; title: ReactNode; side?: boolean; children: ReactNode; foot?: ReactNode; onClose: () => void; badge?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} className={`sheet ${side ? 'side' : ''}`} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose() }}>
      <div className="sheet-head"><div className="row"><h2>{title}</h2>{badge}</div><button className="quiet" aria-label="닫기" onClick={onClose}><Icon name="x" /></button></div>
      <div className="sheet-body">{children}</div>
      {foot && <div className="sheet-foot">{foot}</div>}
    </dialog>
  )
}
