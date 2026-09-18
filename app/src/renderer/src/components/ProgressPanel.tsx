import { useEffect, useRef } from 'react'
import type { RunnerLine, RunnerPhase } from './useRunner'

export interface ProgressPanelProps {
  busy: boolean
  phase: RunnerPhase | null
  elapsedMs: number
  lines: RunnerLine[]
  onCancel?: () => void
  title?: string
}

function seconds(ms: number): string { return `${Math.max(0, Math.floor(ms / 1000))}초` }

function phaseLabel(phase: RunnerPhase | null): string | null {
  if (!phase) return null
  const map: Record<string, string> = { start: '시작', done: '마무리' }
  return map[phase.phase] ?? phase.phase
}

/** Live view of one running sidecar call: elapsed time, phase, streaming log, cancel. */
export function ProgressPanel({ busy, phase, elapsedMs, lines, onCancel, title }: ProgressPanelProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }) }, [lines.length])
  if (!busy && lines.length === 0) return null
  const label = phaseLabel(phase)
  const head = busy
    ? `실행 중 · ${seconds(elapsedMs)}${label ? ` · ${label}` : ''}`
    : `끝남 · ${seconds(elapsedMs)}`
  return (
    <div className="progress" role="status" aria-live="polite" aria-busy={busy}>
      <div className="progress-head">
        {title && <strong>{title}</strong>}
        <span>{head}</span>
        {busy && onCancel && <button type="button" onClick={onCancel}>취소</button>}
      </div>
      {lines.length > 0 && (
        <div className="progress-log" ref={ref}>
          {lines.map((l, i) => <div key={i} className={l.stream === 'stderr' ? 'stderr' : undefined}>{l.line}</div>)}
        </div>
      )}
    </div>
  )
}
