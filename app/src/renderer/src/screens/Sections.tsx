import { useEffect, useState } from 'react'
import { useProject } from '../store/project'
import { rpc, describeError } from '../rpc'
import { StatusPill } from '../components/Pills'
import type { SectionRow } from '../../../shared/types'

/** Read-only by design (interview-ui.md): the agent writes, the transcript is the record. */
export function Sections() {
  const { root } = useProject()
  const [rows, setRows] = useState<SectionRow[]>([])
  const [sel, setSel] = useState<{ id: string; title: string; draft: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = async () => { if (!root) return; try { setRows(await rpc.sections(root)) } catch (e) { setErr(describeError(e)) } }
  useEffect(() => { void load() }, [root])
  const openSection = async (id: string) => { if (!root) return; try { setSel(await rpc.readSection(root, id)) } catch (e) { setErr(describeError(e)) } }
  const label: Record<string, string> = { empty: '비어 있음', drafting: '작성 중', review_ready: '검토 준비' }
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}><h1>절 목록</h1><button onClick={load}>새로고침</button></div>
      {err && <div className="banner bad">{err}</div>}
      <div className="list">
        {rows.length === 0 && <div className="item muted">등록된 절이 없습니다. 에이전트가 절을 등록하면 여기 나타납니다.</div>}
        {rows.map((s) => (
          <div key={s.id} className="item">
            <div className="head">
              <span><strong>{s.order}. {s.title}</strong> <code className="muted">{s.id}</code></span>
              <span><span className="pill">{label[s.status] ?? s.status}</span>{s.draft_hash_ok ? <StatusPill status="pass" /> : <span className="pill fail">본문 변경됨</span>}</span>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>{s.path} · 개정 {s.revision} · {s.draft_chars ?? '?'}자{s.claims != null ? ` · 본문 주장 ${s.claims}건` : ''}{s.error ? ` · ${s.error}` : ''}</div>
            <button style={{ marginTop: 6 }} onClick={() => openSection(s.id)}>미리보기</button>
          </div>
        ))}
      </div>
      {sel && (
        <div style={{ marginTop: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><h2>{sel.title}</h2><button onClick={() => setSel(null)}>닫기</button></div>
          <p className="muted">읽기 전용입니다. 수정은 에이전트에게 요청하세요.</p>
          <pre style={{ maxHeight: 480 }}>{sel.draft}</pre>
        </div>
      )}
    </div>
  )
}
