import { useEffect, useState } from 'react'
import { useProject } from '../store/project'
import { rpc } from '../rpc'
import { Toolbar } from '../components/Toolbar'
import { Badge, StatusBadge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { Feedback } from '../components/Feedback'
import { Sheet } from '../components/Sheet'
import { Icon } from '../components/Icon'
import { EMPTY, READ_ONLY_NOTE, SCREEN_INTRO, STATUS_LABEL, describeError, type DescribedError } from '../copy'
import type { SectionRow } from '../../../shared/types'

/** Read-only by design (interview-ui.md): the agent writes, the transcript is the record. */
export function Sections() {
  const { root } = useProject()
  const [rows, setRows] = useState<SectionRow[]>([])
  const [sel, setSel] = useState<{ id: string; title: string; draft: string } | null>(null)
  const [err, setErr] = useState<DescribedError | null>(null)
  const load = async () => { if (!root) return; try { setRows(await rpc.sections(root)) } catch (e) { setErr(describeError(e)) } }
  useEffect(() => { void load() }, [root])
  const openSection = async (id: string) => { if (!root) return; try { setSel(await rpc.readSection(root, id)) } catch (e) { setErr(describeError(e)) } }
  return (
    <div>
      <Toolbar title="절 목록" sub={<Badge label={`${rows.length}개`} />} actions={<button onClick={load}><Icon name="refresh" size={16} /> 새로고침</button>} />
      <p className="intro">{SCREEN_INTRO.sections}</p>
      {err && <Feedback kind={err.kind} title={err.title} body={err.action} details={<code>{err.raw}</code>} />}
      {rows.length === 0 ? <EmptyState icon="doc" title={EMPTY.sections.title} body={EMPTY.sections.body} /> : (
        <div className="list stagger">
          {rows.map((s, i) => (
            <div key={s.id} className="item" style={{ ['--i' as string]: i }}>
              <div className="head">
                <span><strong>{s.order}. {s.title}</strong> <code className="muted">{s.id}</code></span>
                <span className="row"><Badge label={STATUS_LABEL[s.status] ?? s.status} />{s.draft_hash_ok ? <StatusBadge status="pass" label="정본과 일치" /> : <Badge tone="warning" label="본문 변경됨" />}</span>
              </div>
              <div className="caption">{s.path} · 개정 {s.revision} · {s.draft_chars ?? '?'}자{s.claims != null ? ` · 본문 주장 ${s.claims}건` : ''}{s.error ? ` · ${s.error}` : ''}</div>
              <div style={{ marginTop: 'var(--sp-2)' }}><button onClick={() => openSection(s.id)}>미리보기</button></div>
            </div>
          ))}
        </div>
      )}
      <Sheet open={!!sel} side title={sel?.title ?? ''} badge={<Badge label="읽기 전용" />} onClose={() => setSel(null)}>
        <p className="caption">{READ_ONLY_NOTE}</p>
        <div className="prose">{sel?.draft}</div>
      </Sheet>
    </div>
  )
}
