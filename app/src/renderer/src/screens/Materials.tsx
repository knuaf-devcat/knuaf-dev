import { useEffect, useState } from 'react'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import { rpc } from '../rpc'
import { Toolbar } from '../components/Toolbar'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { Feedback } from '../components/Feedback'
import { EMPTY, MATERIALS, describeError, relativeTime, type DescribedError } from '../copy'
import type { MaterialFact, MaterialsData } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'

const UNDECIDED = new Set(['unknown', 'not_provided', 'withheld'])

function answerLabel(fact: MaterialFact): string {
  return MATERIALS.answerStates[fact.answer_state ?? 'not_provided'] ?? fact.answer_state ?? '—'
}

function factName(fact: MaterialFact): string | null {
  const raw = fact.path ?? fact.value
  return raw ? raw.split(/[\\/]/).pop() ?? raw : null
}

function FactRow({ label, fact }: { label: string; fact: MaterialFact }) {
  const name = factName(fact)
  return (
    <div className="field">
      <label>{label}</label>
      {fact.provided && name ? (
        <span><span title={fact.path ?? fact.value ?? ''}>{name}</span> <Badge label={answerLabel(fact)} tone="accent" /></span>
      ) : fact.answer_state == null || UNDECIDED.has(fact.answer_state) ? (
        <span className="muted">{MATERIALS.notDecided}</span>
      ) : (
        <span><Badge label={answerLabel(fact)} /></span>
      )}
      {fact.note && <span className="help">{fact.note}</span>}
    </div>
  )
}

export function Materials() {
  const { root, setScreen } = useProject(useShallow((s) => ({ root: s.root, setScreen: s.setScreen })))
  const { insertPath } = useChat(useShallow((s) => ({ insertPath: s.insertPath })))
  const platform = window.knuaf.platform
  const joinPath = (rel: string) => `${root}${platform === 'win32' ? '\\' : '/'}${rel}`
  const [data, setData] = useState<MaterialsData | null>(null)
  const [err, setErr] = useState<DescribedError | null>(null)
  const [dragging, setDragging] = useState(false)

  const load = async () => {
    if (!root) return
    try { setData(await rpc.materials(root)); setErr(null) } catch (e) { setErr(describeError(e)) }
  }
  useEffect(() => { void load() }, [root])
  if (!root) return null

  /** Picked/dropped/scanned files only go to the chat draft — nothing is adopted here (intake-selection.md). */
  const attach = (absPath: string) => { insertPath(absPath); setScreen('chat') }
  const pick = async () => { const p = await window.knuaf.pickFile({ title: MATERIALS.attach }); if (p) attach(p) }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) attach(window.knuaf.pathForFile(f))
  }

  return (
    <div>
      <Toolbar title={MATERIALS.title} />
      {err && <Feedback kind={err.kind} title={err.title} body={err.action} details={<code>{err.raw}</code>} />}

      <div className="card">
        <div className="card-head"><h2>{MATERIALS.currentTitle}</h2><span className="caption">{MATERIALS.currentCaption}</span></div>
        {data ? (
          <>
            <FactRow label={MATERIALS.manuscriptLabel} fact={data.current_manuscript} />
            <FactRow label={MATERIALS.financeLabel} fact={data.current_finance} />
          </>
        ) : <p className="caption">불러오는 중…</p>}
      </div>

      <h2>{MATERIALS.refTitle}</h2>
      {data?.reference_materials.note && <p className="caption">{data.reference_materials.note}</p>}
      {data && data.files.length === 0 && <EmptyState icon="files" title={EMPTY.materials_files.title} body={EMPTY.materials_files.body} />}
      <div className="list">
        {data?.files.map((f) => (
          <div key={f.path} className="item">
            <div className="head">
              <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{f.path.split(/[\\/]/).pop()}</strong>
              <span className="row">
                {f.role === 'current' && <Badge label={MATERIALS.roleCurrent} tone="accent" />}
                <button className="quiet" onClick={() => attach(joinPath(f.path))}>{MATERIALS.attachToChat}</button>
              </span>
            </div>
            <div className="reason caption">{f.path} · {relativeTime(f.mtime * 1000)}</div>
          </div>
        ))}
      </div>

      <h2>{MATERIALS.addTitle}</h2>
      <div
        className="dropzone"
        data-dragging={dragging || undefined}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {MATERIALS.dropLine} <button onClick={pick}>{MATERIALS.attach}</button>
        <div className="caption" style={{ marginTop: 'var(--sp-2)' }}>{MATERIALS.addCaption}</div>
      </div>

      <p className="caption" style={{ marginTop: 'var(--sp-4)' }}>{MATERIALS.checkLinePre} <button className="lk" onClick={() => setScreen('checkup')}>{MATERIALS.checkLink}</button>{MATERIALS.checkLinePost}</p>
    </div>
  )
}
