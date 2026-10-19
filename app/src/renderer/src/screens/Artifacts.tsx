import { useEffect, useMemo, useState } from 'react'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import { rpc } from '../rpc'
import { EmptyState } from '../components/EmptyState'
import { Feedback } from '../components/Feedback'
import { Preview } from '../components/Preview'
import { ProgressPanel } from '../components/ProgressPanel'
import { ResultCard } from '../components/ResultCard'
import { useMake } from '../components/useMake'
import { ARTIFACTS, CHECKUP, CLOSE_LABEL, EMPTY, FILES_POPOVER, INDEPENDENT_REVIEW_MISSING, describeError, formatBytes, relativeTime, type DescribedError } from '../copy'
import { joinPath } from '../paths'
import type { ArtifactItem, CheckRow } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'

const KIND_LABEL: Record<string, string> = { docx: 'DOCX', xlsx: 'XLSX', pdf: 'PDF', md: 'MD' }

/** Check rows whose target mentions this file name; fail beats pass, no rows → neutral. */
function CheckBadge({ name, checks }: { name: string; checks: CheckRow[] | null }) {
  const rows = (checks ?? []).filter((c) => c.target.includes(name))
  if (!rows.length) return <span className="caption">{ARTIFACTS.checkNone}</span>
  if (rows.some((r) => r.status === 'fail')) return <span className="badge fail">{ARTIFACTS.checkFail}</span>
  if (rows.some((r) => r.status === 'pass')) return <span className="badge pass">{ARTIFACTS.checkPass}</span>
  return <span className="caption">{ARTIFACTS.checkNone}</span>
}

/**
 * 결과물 — 오른쪽 시트의 **전체 화면** (IMPL-PLAN §4-5).
 *
 * 만들기 로직은 여기 없다: 팝오버·점검 시트와 같은 `useMake()` 를 쓴다. 이 화면이 하는 일은
 * 목록·미리보기·저장이고, 발행 전 고지(독립검토 미실행)는 만들기 버튼 옆에 그대로 남는다.
 * 미리보기(`Preview`)만 전체 화면에 남는다 — 팝오버에 PDF 를 그릴 수는 없다.
 */
export function Artifacts() {
  const { root, status, refresh, loadLists, artifacts, error, clearError, openSettings, closeSheet } = useProject(useShallow((s) => ({
    root: s.root, status: s.status, refresh: s.refresh, loadLists: s.loadLists, artifacts: s.artifacts,
    error: s.error, clearError: s.clearError, openSettings: s.openSettings, closeSheet: s.closeSheet
  })))
  const appendDraft = useChat((s) => s.appendDraft)
  const make = useMake()
  const [sel, setSel] = useState<string | null>(null)
  const [savedTo, setSavedTo] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<DescribedError | null>(null)
  const items = artifacts

  useEffect(() => { void loadLists() }, [loadLists])
  useEffect(() => {
    if (!items) return
    setSel((s) => (s && items.some((i) => i.path === s) ? s : items[0]?.path ?? null))
  }, [items])

  const item = useMemo(() => items?.find((i) => i.path === sel) ?? null, [items, sel])
  const missing = !!status?.lanes.content_review.independent_review_missing
  if (!root) return null

  const saveAs = async (it: ArtifactItem): Promise<void> => {
    setSavedTo(null); setSaveErr(null)
    const r = await window.knuaf.fileSaveAs(root, it.path)
    if (r.error) setSaveErr(describeError(r.error))
    else if (r.result) setSavedTo(String(r.result))
  }
  const tellHelper = (lines: string): void => { appendDraft(lines); closeSheet() }

  return (
    <div>
      {/* 저장 지점의 발행 전 고지 — 점검을 거치지 않고 여기로 와도 독립검토 미실행은 보인다. */}
      {missing && <Feedback kind="warning" title={INDEPENDENT_REVIEW_MISSING.title} body={INDEPENDENT_REVIEW_MISSING.body} />}
      {error && <Feedback kind={error.kind} title={error.title} body={error.action} details={<code>{error.raw}</code>} actions={<button onClick={clearError}>{CLOSE_LABEL}</button>} />}

      {/* 만들기 — 팝오버와 **같은 네 줄**을 같은 조건으로 보여 준다(useMake). 여기서는 한 줄씩
          넓게 편다. 비활성은 "입력이 없어 실행 자체가 불가능한 경우"뿐이고 이유를 캡션으로 말한다. */}
      <div className="card">
        <div className="card-head"><h2>{ARTIFACTS.make.title}</h2></div>
        {make.rows.map((r) => (
          <div className="make-row" key={r.kind}>
            <div className="grow"><div>{r.label}</div><div className="caption">{r.body}</div></div>
            <button onClick={() => void make.run(r.kind)} disabled={!r.enabled || make.making !== null}>{FILES_POPOVER.makeAction}</button>
          </div>
        ))}
      </div>
      {make.feedback && <Feedback kind={make.feedback.kind} title={make.feedback.title} body={make.feedback.body} details={make.feedback.details} actions={make.feedback.actions} />}
      {make.runner.busy && <ProgressPanel busy={make.runner.busy} phase={make.runner.phase} elapsedMs={make.runner.elapsedMs} lines={make.runner.lines} onCancel={make.runner.cancel} />}
      {make.runner.err && !make.runner.busy && !make.feedback && (
        <Feedback kind="error" title={ARTIFACTS.make.failTitle} body={make.runner.err} details={<code>{make.runner.err}</code>}
          actions={make.failedTool ? <button onClick={() => openSettings(make.failedTool)}>{ARTIFACTS.make.advancedOpen}</button> : undefined} />
      )}
      {make.runner.env?.ok && !make.runner.busy && <ResultCard env={make.runner.env} onReveal={(p) => window.knuaf.reveal(joinPath(root, p))} onOpen={(p) => window.knuaf.openPath(joinPath(root, p))} />}

      <h2>{ARTIFACTS.make.madeTitle}</h2>
      {items && items.length === 0 && <EmptyState icon="box" title={EMPTY.artifacts.title} body={EMPTY.artifacts.body} />}

      {items && items.length > 0 && (
        <div className="artifact-grid">
          <div className="list artifact-list">
            {items.map((i) => (
              <div key={i.path} className={`item ${sel === i.path ? 'active' : ''}`} onClick={() => setSel(i.path)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSel(i.path) }}>
                <div className="head">
                  <span className="row" style={{ minWidth: 0 }}>
                    <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.path}>{i.name}</strong>
                    <span className="badge accent">{KIND_LABEL[i.kind] ?? i.kind}</span>
                  </span>
                  <CheckBadge name={i.name} checks={status?.checks ?? null} />
                </div>
                <div className="caption">
                  {i.revision != null && <>{CHECKUP.record(i.revision)} · </>}
                  {formatBytes(i.bytes)} · {relativeTime(i.mtime * 1000)}
                </div>
                <div className="caption" title={i.path}>{i.path}</div>
              </div>
            ))}
          </div>

          <div className="card">
            {item ? (
              <>
                <div className="card-head">
                  <h2 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.path}>{item.name}</h2>
                  <span className="row">
                    <button onClick={() => void saveAs(item)}>{ARTIFACTS.save}</button>
                    <button onClick={() => window.knuaf.reveal(joinPath(root, item.path))}>{ARTIFACTS.reveal}</button>
                    <button onClick={() => window.knuaf.openPath(joinPath(root, item.path))}>{ARTIFACTS.openExternal}</button>
                  </span>
                </div>
                {savedTo && <div style={{ marginBottom: 'var(--sp-3)' }}><Feedback kind="completion" title={ARTIFACTS.savedTo} body={<code>{savedTo}</code>} /></div>}
                {saveErr && <div style={{ marginBottom: 'var(--sp-3)' }}><Feedback kind={saveErr.kind} title={saveErr.title} body={saveErr.action} details={<code>{saveErr.raw}</code>} /></div>}
                <Preview root={root} item={item} items={items} onRendered={() => { void refresh(); void loadLists() }} />
              </>
            ) : (
              <EmptyState icon="doc" title={ARTIFACTS.previewTitle} body={ARTIFACTS.pickOne} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
