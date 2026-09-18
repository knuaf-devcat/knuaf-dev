import { Sheet } from './Sheet'

export function Confirm({ open, title, body, confirmLabel = '진행', danger, onConfirm, onCancel }: {
  open: boolean; title: string; body: React.ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void
}) {
  return (
    <Sheet open={open} title={title} onClose={onCancel} foot={<><button onClick={onCancel}>취소</button><button className={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</button></>}>
      {body}
    </Sheet>
  )
}
