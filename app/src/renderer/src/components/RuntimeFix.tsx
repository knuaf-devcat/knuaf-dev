import { useEffect, useRef, useState } from 'react'
import { Feedback } from './Feedback'
import { ProgressPanel } from './ProgressPanel'
import { describeError, formatBytes, RUNTIME, type DescribedError } from '../copy'
import type { RuntimeStatus, SidecarInfo } from '../../../shared/types'
import { useProject } from '../store/project'

/** 시작 실패와 그때 선택됐던 인터프리터(PY-D1-03). store 의 `openFailure` 가 이 모양이다. */
export interface RuntimeFailure {
  sidecar: Pick<SidecarInfo, 'python' | 'kind'>
  code: string
}

/** 인터프리터 계열 시작 실패 — 이 셋만 준비 버튼의 후보다. */
const INTERPRETER_FAILURES: Record<string, true> = { python_too_old: true, spawn_failed: true, sidecar_exited: true }

/**
 * 준비 버튼을 세울 수 있는 실패인가(D8, §7 PY-D1-02).
 * - `env`(override·KNUAF_PYTHON): 학생이 고른 경로를 몰래 무시하지 않는다 — 기존 안내만.
 * - `venv`: 읽을 수 있는 낡은 cfg 는 이미 선택에서 빠지므로 여기 오는 것은 못 읽는 venv 뿐.
 *   자동 복구 대신 `.venv` 이름을 바꾸는 안내를 보여 준다.
 */
export function runtimeFixKind(failure: RuntimeFailure, supported: boolean): 'button' | 'venv' | 'none' {
  if (!INTERPRETER_FAILURES[failure.code] || !supported) return 'none'
  if (failure.sidecar.kind === 'venv') return 'venv'
  return failure.sidecar.kind === 'path' || failure.sidecar.kind === 'bundled' ? 'button' : 'none'
}

/**
 * 설치 한 번의 상태(진행률·오류) — 오류 카드의 준비 버튼과 설정의 상시 버튼이 **같은 규칙**으로
 * 돈다. 두 벌로 두면 한쪽만 진행률을 갱신하거나 취소를 잊는다.
 */
function useRuntimeInstall() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<string | null>(null)
  const [lines, setLines] = useState<{ stream: string; line: string }[]>([])
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState<DescribedError | null>(null)
  const startedAt = useRef(0)

  useEffect(() => {
    let alive = true
    void window.knuaf.runtime.status().then((r) => { if (alive) setStatus(r.result) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setElapsedMs(Date.now() - startedAt.current), 250)
    return () => clearInterval(t)
  }, [busy])

  const install = async (): Promise<boolean> => {
    setError(null); setLines([]); setPhase(null)
    startedAt.current = Date.now(); setElapsedMs(0); setBusy(true)
    try {
      const r = await window.knuaf.runtime.install((event, data) => {
        if (event !== 'progress') return
        const p = data as { phase?: unknown; received?: unknown; total?: unknown }
        const name = typeof p.phase === 'string' ? p.phase : RUNTIME.progressFallback
        const received = typeof p.received === 'number' ? p.received : 0
        const total = typeof p.total === 'number' ? p.total : 0
        setPhase(name)
        setLines((l) => [...l.slice(-19), { stream: 'stdout', line: total ? `${name} ${Math.round(received / 1048576)}/${Math.round(total / 1048576)}MB` : name }])
      })
      if (r.error) {
        // 취소는 오류가 아니라 상태다 — 카드에 다시 시도만 남긴다.
        if (r.error.code !== 'runtime_cancelled') setError(describeError(r.error))
        return false
      }
      setStatus((s) => (s ? { ...s, installed: true } : s))
      return true
    } finally {
      setBusy(false)
    }
  }

  return { status, busy, phase, lines, elapsedMs, error, install }
}

/** 진행률 한 줄 — 두 버튼이 같은 모양으로 보여 준다. */
function InstallProgress({ busy, phase, lines, elapsedMs }: { busy: boolean; phase: string | null; lines: { stream: string; line: string }[]; elapsedMs: number }) {
  if (!busy) return null
  return <ProgressPanel busy={busy} phase={phase ? { phase } : null} elapsedMs={elapsedMs} lines={lines}
    onCancel={() => void window.knuaf.runtime.cancel()} title={RUNTIME.busyTitle} />
}

/**
 * 설정 > Python 실행기 카드의 상시 버튼(D8). 오류 카드가 없어도 여기서 준비할 수 있다.
 * `onRetry` 가 없다 — 설치 후 main 이 사이드카를 다시 띄우는 것으로 끝난다.
 */
export function RuntimeSetup() {
  const { status, busy, phase, lines, elapsedMs, error, install } = useRuntimeInstall()
  const refreshSidecar = useProject((s) => s.refreshSidecar)
  if (!status) return null
  if (!status.supported) return <div className="caption">{RUNTIME.settingsNote}</div>
  return (
    <div>
      <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
        <button className={status.installed ? undefined : 'primary'} disabled={busy}
          onClick={() => void install().then(async (ok) => { if (ok) await refreshSidecar() })}>
          {busy ? RUNTIME.busyTitle : status.installed ? RUNTIME.again : RUNTIME.button}
        </button>
        <span className="caption">{status.installed ? RUNTIME.installed : RUNTIME.settingsNote}</span>
      </div>
      {error && <Feedback kind="warning" title={error.title} body={error.action} details={<code>{error.raw}</code>} />}
      <InstallProgress busy={busy} phase={phase} lines={lines} elapsedMs={elapsedMs} />
    </div>
  )
}

/**
 * 오류 카드 옆에 서는 "Python 자동으로 준비하기" 한 장(D8).
 *
 * 설치는 main 이 프로세스 전역 1건으로 합류시키므로 두 번 눌러도 한 번만 받는다. 끝나면
 * `onRetry`(실패했던 폴더 열기)를 부르고, **그 결과가 또 실패면** 설치 성공을 복구 성공으로
 * 표시하지 않는다 — 새 오류 카드는 호출한 화면이 그대로 보여 준다(§7).
 */
export function RuntimeFix({ failure, onRetry }: { failure: RuntimeFailure; onRetry?: () => Promise<boolean> }) {
  const { status, busy, phase, lines, elapsedMs, error, install } = useRuntimeInstall()
  const [outcome, setOutcome] = useState<null | 'installed' | 'retry_failed'>(null)

  if (!status) return null
  const kind = runtimeFixKind(failure, status.supported)
  if (kind === 'venv') return <Feedback kind="warning" title={RUNTIME.fixTitle} body={RUNTIME.venvStaleAction} />
  if (kind === 'none') return null
  if (outcome === 'installed') return <Feedback kind="completion" title={RUNTIME.installed} body={RUNTIME.installedBody} />
  if (outcome === 'retry_failed') return <Feedback kind="warning" title={RUNTIME.retryFailedTitle} body={RUNTIME.retryFailedBody} />
  if (status.installed && !busy && !error) return null

  const size = status.sizeBytes ? formatBytes(status.sizeBytes) : RUNTIME.sizeFallback
  const run = async (): Promise<void> => {
    setOutcome(null)
    if (!(await install())) return
    // 설치 성공 ≠ 폴더 복구 성공(§7) — 재시도 결과를 그대로 반영한다.
    const ok = onRetry ? await onRetry() : true
    setOutcome(ok ? 'installed' : 'retry_failed')
  }

  return (
    <div>
      <Feedback
        kind="warning"
        title={RUNTIME.fixTitle}
        body={error ? `${error.title}${error.action ? ' ' + error.action : ''}` : RUNTIME.fixAction(size)}
        actions={busy
          ? <button onClick={() => void window.knuaf.runtime.cancel()}>{RUNTIME.cancel}</button>
          : <button className="primary" onClick={() => void run()}>{error ? RUNTIME.again : RUNTIME.button}</button>}
        details={error ? <code>{error.raw}</code> : undefined}
      />
      <InstallProgress busy={busy} phase={phase} lines={lines} elapsedMs={elapsedMs} />
    </div>
  )
}
