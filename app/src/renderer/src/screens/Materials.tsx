import { useEffect, useState } from 'react'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { EMPTY, MATERIALS, relativeTime } from '../copy'
import { joinPath } from '../paths'
import type { MaterialFact } from '../../../shared/types'
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

/**
 * 자료 — 오른쪽 시트로 열리는 한 장 (IMPL-PLAN §4-5). 사이드바 목적지에서 내려왔지만
 * 내용은 그대로다: 현재 작성물·참고자료·파일 추가. 목록은 `store/project` 가 들고 있다
 * (종이 머리의 "자료 N" 팝오버와 같은 것을 본다).
 */
export function Materials() {
  const { root, materials, loadLists, closeSheet } = useProject(useShallow((s) => ({
    root: s.root, materials: s.materials, loadLists: s.loadLists, closeSheet: s.closeSheet
  })))
  const insertPath = useChat((s) => s.insertPath)
  const [dragging, setDragging] = useState(false)

  useEffect(() => { void loadLists() }, [loadLists])

  if (!root) return null

  /** 고른 파일은 대화 초안 끝에 붙기만 한다 — 여기서 채택되지 않는다(intake-selection.md). */
  const attach = (absPath: string): void => { insertPath(absPath); closeSheet() }
  const pick = async (): Promise<void> => { const p = await window.knuaf.pickFile({ title: MATERIALS.attach }); if (p) attach(p) }
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) attach(window.knuaf.pathForFile(f))
  }

  return (
    <div>
      <section className="card">
        <div className="card-head"><h2>{MATERIALS.currentTitle}</h2><span className="caption">{MATERIALS.currentCaption}</span></div>
        {materials ? (
          <>
            <FactRow label={MATERIALS.manuscriptLabel} fact={materials.current_manuscript} />
            <FactRow label={MATERIALS.financeLabel} fact={materials.current_finance} />
          </>
        ) : <p className="caption">{MATERIALS.loading}</p>}
      </section>

      <h2>{MATERIALS.refTitle}</h2>
      {materials?.reference_materials.note && <p className="caption">{materials.reference_materials.note}</p>}
      {materials && materials.files.length === 0 && <EmptyState icon="files" title={EMPTY.materials_files.title} body={EMPTY.materials_files.body} />}
      <div className="list">
        {materials?.files.map((f) => (
          <div key={f.path} className="item">
            <div className="head">
              <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{f.path.split(/[\\/]/).pop()}</strong>
              <span className="row">
                {f.role === 'current' && <Badge label={MATERIALS.roleCurrent} tone="accent" />}
                <button className="quiet" onClick={() => attach(joinPath(root, f.path))}>{MATERIALS.attachToChat}</button>
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
        {MATERIALS.dropLine} <button onClick={() => void pick()}>{MATERIALS.attach}</button>
        <div className="caption" style={{ marginTop: 'var(--sp-2)' }}>{MATERIALS.addCaption}</div>
      </div>
    </div>
  )
}
