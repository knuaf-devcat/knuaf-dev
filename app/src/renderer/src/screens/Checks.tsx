import { useMemo, useState } from 'react'
import { useProject } from '../store/project'
import { rpc, describeError } from '../rpc'
import { OwnerPill, SeverityPill, StatusPill } from '../components/Pills'
import type { CheckRow } from '../../../shared/types'

export function Checks() {
  const { status, root, refresh, loading } = useProject()
  const [scope, setScope] = useState<'all' | 'submission'>('all')
  const [rows, setRows] = useState<CheckRow[] | null>(null)
  const [filter, setFilter] = useState({ status: '', severity: '', owner: '', q: '' })
  const [err, setErr] = useState<string | null>(null)
  const source = rows ?? (scope === 'submission' ? status?.gate : status?.checks) ?? []
  const shown = useMemo(() => source.filter((r) =>
    (!filter.status || r.status === filter.status) && (!filter.severity || r.severity === filter.severity) && (!filter.owner || (r.owner ?? 'skill') === filter.owner) &&
    (!filter.q || (r.check_id + ' ' + r.target + ' ' + r.reason).includes(filter.q))), [source, filter])
  const run = async (s: 'all' | 'submission') => {
    if (!root) return
    setScope(s); setErr(null)
    try { setRows(await rpc.checks(root, s)) } catch (e) { setErr(describeError(e)) }
  }
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>검사 결과</h1>
        <div className="row">
          <button className={scope === 'all' ? 'primary' : ''} onClick={() => run('all')}>전체 검사</button>
          <button className={scope === 'submission' ? 'primary' : ''} onClick={() => run('submission')}>제출 후보 관문</button>
          <button onClick={() => { setRows(null); void refresh() }} disabled={loading}>새로고침</button>
        </div>
      </div>
      {err && <div className="banner bad">{err}</div>}
      <div className="row" style={{ margin: '8px 0 12px' }}>
        <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}><option value="">상태: 전체</option><option value="pass">통과</option><option value="fail">실패</option><option value="blocked">보류</option><option value="not_configured">미설정</option></select>
        <select value={filter.severity} onChange={(e) => setFilter({ ...filter, severity: e.target.value })}><option value="">심각도: 전체</option><option value="error">오류</option><option value="warning">경고</option></select>
        <select value={filter.owner} onChange={(e) => setFilter({ ...filter, owner: e.target.value })}><option value="">담당: 전체</option><option value="skill">스킬</option><option value="user">나</option><option value="professor">교수</option></select>
        <input placeholder="검사 ID·대상·사유 검색" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
        <span className="muted">{shown.length} / {source.length}</span>
      </div>
      <div className="list">
        {shown.map((r, i) => (
          <div key={r.check_id + r.target + i} className="item">
            <div className="head"><span><code>{r.check_id}</code> · <code>{r.target}</code></span><span><StatusPill status={r.status} /><SeverityPill severity={r.severity} /><OwnerPill owner={r.owner ?? 'skill'} /></span></div>
            <div className="reason">{r.reason}</div>
            {r.evidence && r.evidence.length > 0 && <div className="evidence">{JSON.stringify(r.evidence)}</div>}
            {r.required_for && r.required_for.length > 0 && <div className="muted" style={{ fontSize: 12 }}>필요 대상: {r.required_for.join(', ')} · 입력 개정 {r.input_revision}</div>}
          </div>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 12 }}>보류(blocked)는 "해당 없음"으로 바꿀 수 없습니다. 근거를 등록하거나 에이전트에게 알려 주세요.</p>
    </div>
  )
}
