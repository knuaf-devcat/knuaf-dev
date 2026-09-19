import { useEffect, useState } from 'react'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import { rpc } from '../rpc'
import { Toolbar } from '../components/Toolbar'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { Feedback } from '../components/Feedback'
import { EMPTY, MATERIALS, SCREEN_INTRO, describeError, formatBytes, relativeTime, type DescribedError } from '../copy'
import type { MaterialFact, MaterialsData } from '../../../shared/types'

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
    <div className="item">
      <div className="head">
        <span className="row">
          <strong>{label}</strong>
          {fact.provided && name ? (
            <span title={fact.path ?? fact.value ?? ''}>{name}</span>
          ) : fact.answer_state == null || UNDECIDED.has(fact.answer_state) ? (
            <span className="caption">{MATERIALS.notDecided}</span>
          ) : null}
        </span>
        <Badge label={answerLabel(fact)} tone={fact.provided ? 'pass' : undefined} />
      </div>
      {fact.note && <div className="reason">{fact.note}</div>}
    </div>
  )
}

export function Materials() {
  const { root, setScreen } = useProject()
  const { insertPath } = useChat()
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

  const decided = data?.current_manuscript.provided || data?.current_finance.provided

  return (
    <div>
      <Toolbar title={MATERIALS.title} actions={<button onClick={() => setScreen('checks')}>검사 결과 보기</button>} />
      <p className="intro">{SCREEN_INTRO.materials}</p>
      {err && <Feedback kind={err.kind} title={err.title} body={err.action} details={<code>{err.raw}</code>} />}

      <div className="card">
        <div className="card-head"><h2>{MATERIALS.currentTitle}</h2>{data?.work_basis && <Badge label={`${MATERIALS.workBasis}: ${data.work_basis}`} />}</div>
        <div className="list">
          {data ? (
            <>
              <FactRow label={MATERIALS.manuscriptLabel} fact={data.current_manuscript} />
              <FactRow label={MATERIALS.financeLabel} fact={data.current_finance} />
            </>
          ) : <p className="caption">불러오는 중…</p>}
        </div>
        {!decided && <p className="caption" style={{ marginTop: 'var(--sp-3)' }}>{MATERIALS.addCaption}</p>}
      </div>

      <div className="card">
        <div className="card-head"><h2>{MATERIALS.refTitle}</h2>{data && <Badge label={answerLabel(data.reference_materials)} tone={data.reference_materials.provided ? 'pass' : undefined} />}</div>
        {data?.reference_materials.note && <p className="caption">{data.reference_materials.note}</p>}
        {data?.reference_materials.value && <p className="caption">{data.reference_materials.value}</p>}
        {data && data.files.length === 0 && <EmptyState icon="files" title={EMPTY.materials_files.title} body={EMPTY.materials_files.body} />}
        <div className="list">
          {data?.files.map((f) => (
            <div key={f.path} className="item">
              <div className="head">
                <span className="row" style={{ minWidth: 0 }}>
                  <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{f.path.split(/[\\/]/).pop()}</strong>
                  <Badge label={f.role === 'current' ? MATERIALS.roleCurrent : MATERIALS.roleReference} tone={f.role === 'current' ? 'accent' : undefined} />
                </span>
                <span className="row">
                  <button onClick={() => attach(joinPath(f.path))}>{MATERIALS.attachToChat}</button>
                  <button onClick={() => window.knuaf.reveal(joinPath(f.path))}>{MATERIALS.reveal}</button>
                </span>
              </div>
              <div className="caption">{f.path} · {formatBytes(f.bytes)} · {relativeTime(f.mtime * 1000)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>{MATERIALS.addTitle}</h2></div>
        <p>{MATERIALS.addBody}</p>
        <div
          className="dropzone"
          data-dragging={dragging || undefined}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p className="caption">{MATERIALS.dropHint}</p>
          <button className="primary" onClick={pick}>{MATERIALS.attach}</button>
        </div>
        <p className="caption" style={{ marginTop: 'var(--sp-3)' }}>{MATERIALS.addCaption}</p>
      </div>
    </div>
  )
}
