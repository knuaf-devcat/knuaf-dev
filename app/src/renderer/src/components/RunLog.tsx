import { useEffect, useRef } from 'react'

export type LogLine = { stream: string; line: string }

export function RunLog({ lines, title }: { lines: LogLine[]; title?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }) }, [lines.length])
  if (lines.length === 0) return null
  return (
    <div>
      {title && <h3>{title}</h3>}
      <div className="log" ref={ref}>
        {lines.map((l, i) => <div key={i} className={l.stream}>{l.line}</div>)}
      </div>
    </div>
  )
}
