import { useEffect, useRef, type ReactNode } from 'react'

/**
 * 제목줄·종이 머리에 붙는 작은 팝오버(DESIGN §1-3, 시안 ⑩⑬⑭).
 *
 * 시트(dialog)와 다른 물건이다: 시트는 논문 위를 덮는 한 장(자료·결과물·점검·설정),
 * 팝오버는 단추 아래에 잠깐 열리는 목록이다. 자리를 재서 창 밖으로 나가지 않게 하는
 * 대신, **부모(`.pop-host`) 기준으로** 붙인다 — 앵커와 같은 상자 안에 있으므로
 * 가로 위치는 `align` 으로 정하고 세로는 늘 단추 아래다(mockup 의 측정 방식과 같은 결과).
 *
 * Esc·바깥 누름으로 닫힌다. 여는 단추 자체는 바깥이 아니다(누르면 토글된다).
 */
export function Popover({ open, onClose, align = 'left', width, label, children }: {
  open: boolean
  onClose: () => void
  align?: 'left' | 'right' | 'center'
  width?: number
  label: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const host = ref.current?.parentElement
      // 여는 단추(`host` 안의 형제)와 팝오버 자신은 바깥이 아니다.
      if (host && e.target instanceof Node && host.contains(e.target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, onClose])
  if (!open) return null
  return (
    <div ref={ref} className={`popover align-${align}`} role="dialog" aria-label={label} style={width ? { width } : undefined}>
      {children}
    </div>
  )
}

/** 팝오버 목록의 한 줄. `mono`는 경로처럼 글자 폭을 맞춰야 하는 자리. */
export function PopRow({ icon, children, meta, onClick, current, disabled }: {
  icon?: ReactNode
  children: ReactNode
  meta?: ReactNode
  onClick?: () => void
  current?: boolean
  disabled?: boolean
}) {
  const body = <>{icon}{children}{meta && <span className="m">{meta}</span>}</>
  if (!onClick) return <div className={`pop-row${current ? ' cur' : ''}`}>{body}</div>
  return <button type="button" className={`pop-row${current ? ' cur' : ''}`} onClick={onClick} disabled={disabled}>{body}</button>
}

/** 팝오버 목록의 머리글. */
export function PopHead({ children }: { children: ReactNode }) {
  return <div className="pop-head">{children}</div>
}

/** 팝오버 안의 구분선. */
export function PopSep() {
  return <div className="pop-sep" />
}
