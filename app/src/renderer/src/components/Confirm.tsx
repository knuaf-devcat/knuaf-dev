import { useEffect, useRef } from 'react'

export function Confirm({ open, title, body, confirmLabel = '진행', danger, onConfirm, onCancel }: {
  open: boolean; title: string; body: React.ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
  return (
    <dialog ref={ref} onClose={onCancel}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <div>{body}</div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={onCancel}>취소</button>
        <button className={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </dialog>
  )
}
