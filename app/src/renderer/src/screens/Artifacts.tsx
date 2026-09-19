import { useEffect, useMemo, useState } from 'react'
import { useProject } from '../store/project'
import { rpc } from '../rpc'
import { Toolbar } from '../components/Toolbar'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { Feedback } from '../components/Feedback'
import { Preview } from '../components/Preview'
import { ARTIFACTS, EMPTY, SCREEN_INTRO, describeError, formatBytes, relativeTime, type DescribedError } from '../copy'
import type { ArtifactItem, CheckRow } from '../../../shared/types'

const KIND_LABEL: Record<string, string> = { docx: 'DOCX', xlsx: 'XLSX', pdf: 'PDF', md: 'MD' }

/** Check rows whose target mentions this file name; fail beats pass, no rows → neutral. */
function CheckBadge({ name, checks }: { name: string; checks: CheckRow[] | null }) {
  const rows = (checks ?? []).filter((c) => c.target.includes(name))
  if (!rows.length) return <Badge label={ARTIFACTS.checkNone} />
  if (rows.some((r) => r.status === 'fail')) return <Badge tone="fail" label={ARTIFACTS.checkFail} />
  if (rows.some((r) => r.status === 'pass')) return <Badge tone="pass" label={ARTIFACTS.checkPass} />
  return <Badge label={ARTIFACTS.checkNone} />
}

export function Artifacts() {
  const { root, status, setScreen } = useProject()
  const platform = window.knuaf.platform
  const joinPath = (rel: string) => `${root}${platform === 'win32' ? '\\' : '/'}${rel}`
  const [items, setItems] = useState<ArtifactItem[] | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [err, setErr] = useState<DescribedError | null>(null)
  const [savedTo, setSavedTo] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<DescribedError | null>(null)

  const load = async () => {
    if (!root) return
    try {
      const r = await rpc.artifacts(root)
      setItems(r.items)
      setSel((s) => (s && r.items.some((i) => i.path === s) ? s : r.items[0]?.path ?? null))
      setErr(null)
    } catch (e) { setErr(describeError(e)) }
  }
  useEffect(() => { void load() }, [root])
  const item = useMemo(() => items?.find((i) => i.path === sel) ?? null, [items, sel])
  if (!root) return null

  const saveAs = async (it: ArtifactItem) => {
    setSavedTo(null); setSaveErr(null)
    const r = await window.knuaf.fileSaveAs(root, it.path)
    if (r.error) setSaveErr(describeError(r.error))
    else if (r.result) setSavedTo(String(r.result))
  }

  return (
    <div>
      <Toolbar title={ARTIFACTS.title} actions={<><button onClick={() => setScreen('checks')}>검사 결과 보기</button><button onClick={load}>{ARTIFACTS.refresh}</button></>} />
      <p className="intro">{SCREEN_INTRO.artifacts}</p>
      {err && <Feedback kind={err.kind} title={err.title} body={err.action} details={<code>{err.raw}</code>} />}
      {items && items.length === 0 && <EmptyState icon="box" title={EMPTY.artifacts.title} body={EMPTY.artifacts.body} />}

      {items && items.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)', gap: 'var(--sp-4)', alignItems: 'start' }}>
          <div className="list artifact-list">
            {items.map((i) => (
              <div key={i.path} className={`item ${sel === i.path ? 'active' : ''}`} onClick={() => setSel(i.path)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSel(i.path) }}>
                <div className="head">
                  <span className="row" style={{ minWidth: 0 }}>
                    <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.path}>{i.name}</strong>
                    <Badge label={KIND_LABEL[i.kind] ?? i.kind} tone="accent" />
                  </span>
                  <CheckBadge name={i.name} checks={status?.checks ?? null} />
                </div>
                <div className="caption">
                  {i.revision != null && <>{ARTIFACTS.revision} {i.revision} · </>}
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
                    <button onClick={() => window.knuaf.reveal(joinPath(item.path))}>{ARTIFACTS.reveal}</button>
                    <button onClick={() => window.knuaf.openPath(joinPath(item.path))}>{ARTIFACTS.openExternal}</button>
                  </span>
                </div>
                {savedTo && <div style={{ marginBottom: 'var(--sp-3)' }}><Feedback kind="completion" title={ARTIFACTS.savedTo} body={<code>{savedTo}</code>} /></div>}
                {saveErr && <div style={{ marginBottom: 'var(--sp-3)' }}><Feedback kind={saveErr.kind} title={saveErr.title} body={saveErr.action} details={<code>{saveErr.raw}</code>} /></div>}
                <Preview root={root} item={item} items={items} onRendered={load} />
              </>
            ) : (
              <EmptyState icon="doc" title={ARTIFACTS.previewTitle} body="왼쪽 목록에서 파일을 골라 주세요." />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
