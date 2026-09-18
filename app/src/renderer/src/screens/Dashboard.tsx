import { useProject } from '../store/project'
import { ErrorBanner } from '../components/Banners'
import { StatusPill } from '../components/Pills'
import type { LaneSummary } from '../../../shared/types'

function Counts({ s }: { s: LaneSummary }) {
  return <div className="row"><span className="pill pass">통과 {s.pass}</span><span className="pill fail">실패 {s.fail}</span><span className="pill blocked">보류 {s.blocked}</span>{s.other > 0 && <span className="pill">기타 {s.other}</span>}</div>
}

/** SKILL.md:34 — four lanes, never one checkmark; user_finish is the student's own list. */
export function Dashboard() {
  const { status, refresh, loading, error, setScreen } = useProject()
  if (!status) return <div><ErrorBanner error={error} /><button onClick={refresh} disabled={loading}>새로고침</button></div>
  const L = status.lanes
  const KIND: Record<string, string> = { content: '내용', logic: '논리', calculation: '계산', docx: 'DOCX', xlsx: 'XLSX', render: '렌더' }
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>대시보드 <span className="muted" style={{ fontSize: 13 }}>정본 개정 {status.revision}</span></h1>
        <button onClick={refresh} disabled={loading}>{loading ? '읽는 중…' : '새로고침'}</button>
      </div>
      <ErrorBanner error={error} />
      <div className="grid">
        <div className="card">
          <div className="title">1. 기계검사 {L.machine.ready ? <StatusPill status="pass" /> : <StatusPill status="blocked" />}</div>
          <Counts s={L.machine.summary} />
          <div className="meta">파일 해시·사실·계산·절 대조. {L.machine.ready ? '스킬 검사 완료 상태(교수 확인 전).' : '아직 스킬 검사가 끝나지 않았습니다.'}</div>
          <button style={{ marginTop: 8 }} onClick={() => setScreen('checks')}>자세히</button>
        </div>
        <div className="card">
          <div className="title">2. 내용검토(독립)</div>
          <div className="row">{Object.entries(L.content_review.by_kind).map(([k, v]) => <span key={k} className={'pill ' + v}>{KIND[k] ?? k}</span>)}</div>
          <div className="meta">작성자와 다른 검토자가 원문과 대조한 기록. {L.content_review.independent_review_missing ? '아직 없음.' : ''}</div>
        </div>
        <div className="card">
          <div className="title">3. 실제 출력검토</div>
          <Counts s={L.output_review.summary} />
          <div className="meta">DOCX/XLSX 파일·글꼴·재계산·렌더 검사. 학교 지침 준비: {L.output_review.guideline_ready === null ? '미설정' : L.output_review.guideline_ready ? '준비됨' : '미완'}</div>
        </div>
        <div className="card">
          <div className="title">4. 교수 승인</div>
          <div className="meta">{L.professor.recorded ? '승인 근거 기록이 등록되어 있습니다.' : '별도 기록 확인 필요. 앱이 승인을 판정하지 않습니다.'}</div>
        </div>
      </div>
      <h2>내가 할 일 (한글에서 마무리)</h2>
      <p className="muted">아래 항목은 사람이 직접 확인하는 일이며, Ⅰ~Ⅵ 작성이나 DOCX/XLSX 작업을 막지 않습니다.</p>
      <div className="list">
        {status.user_finish_pending.length === 0 && <div className="item muted">없음</div>}
        {status.user_finish_pending.map((u) => <div key={u.id} className="item"><div className="head"><strong>{u.id}</strong><StatusPill status={u.status} /></div><div className="reason">{u.reason}</div></div>)}
      </div>
      <h2>등록 현황</h2>
      <div className="row">{Object.entries(status.counts).map(([k, v]) => <span key={k} className="pill">{k} {v}</span>)}</div>
      <p className="muted" style={{ marginTop: 12 }}>{status.completion.notice}</p>
    </div>
  )
}
