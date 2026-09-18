import { useEffect, useRef, useState } from 'react'

export function SegmentedControl<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null)
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLButtonElement>(`button[data-id="${CSS.escape(value)}"]`)
    if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth })
  }, [value, options.length])
  return (
    <div className="segmented" role="tablist" aria-label={label} ref={ref}>
      {thumb && <span className="thumb" style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }} aria-hidden="true" />}
      {options.map((o) => (
        <button key={o.id} role="tab" data-id={o.id} aria-selected={o.id === value} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  )
}
