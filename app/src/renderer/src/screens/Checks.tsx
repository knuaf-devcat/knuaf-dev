import { useEffect, useMemo, useState } from 'react'
import { useProject } from '../store/project'
import { rpc } from '../rpc'
import { Toolbar } from '../components/Toolbar'
import { SegmentedControl } from '../components/SegmentedControl'
import { Feedback } from '../components/Feedback'
import { Badge, StatusBadge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { Disclosure } from '../components/Disclosure'
import { Icon } from '../components/Icon'
import { EMPTY, OWNER_LABEL, SCREEN_INTRO, SEVERITY_LABEL, describeError, type DescribedError } from '../copy'
import type { CheckRow } from '../../../shared/types'

const ORDER: [string, string][] = [['fail', '실패'], ['blocked', '보류'], ['not_configured', '미설정'], ['pending', '대기'], ['pass', '통과']]

export function Checks() {
  const { status, root, refresh, loading, checksPreset } = useProject()
  const [scope, setScope] = useState<'all' | 'submission'>('all')
  const [rows, setRows] = useState<CheckRow[] | null>(null)
  const [filter, setFilter] = useState({ status: '', severity: '', owner: checksPreset?.owner ?? '', q: checksPreset?.prefix ?? '' })
  const [err, setErr] = useState<DescribedError | null>(null)
  useEffect(() => { if (checksPreset) setFilter((f) => ({ ...f, owner: checksPreset.owner ?? '', q: checksPreset.prefix ?? '' })) }, [checksPreset])
  const source = rows ?? (scope === 'submission' ? status?.gate : status?.checks) ?? []
  const shown = useMemo(() => source.filter((r) =>
    (!filter.status || r.status === filter.status) && (!filter.severity || r.severity === filter.severity) && (!filter.owner || (r.owner ?? 'skill') === filter.owner) &&
    (!filter.q || (r.check_id + ' ' + r.target + ' ' + r.reason).includes(filter.q))), [source, filter])
  const run = async (s: 'all' | 'submission') => {
    if (!root) return
    setScope(s); setErr(null)
    try { setRows(await rpc.checks(root, s)) } catch (e) { setErr(describeError(e)) }
  }
  const groups = ORDER.map(([k, label]) => ({ k, label, rows: shown.filter((r) => r.status === k) })).filter((g) => g.rows.length)
  const rest = shown.filter((r) => !ORDER.some(([k]) => k === r.status))
  const Row = ({ r }: { r: CheckRow }) => (
    <div className="item">
      <div className="head"><span><code>{r.check_id}</code> <span className="muted">·</span> {r.target}</span><span className="row"><StatusBadge status={r.status} /><Badge tone={r.severity === 'warning' ? 'warning' : ''} label={SEVERITY_LABEL[r.severity] ?? r.severity} /><Badge label={OWNER_LABEL[r.owner ?? 'skill'] ?? r.owner} /></span></div>
      <div className="reason">{r.reason}</div>
      {((r.evidence && r.evidence.length > 0) || (r.required_for && r.required_for.length > 0)) && (
        <Disclosure label="근거">
          {r.evidence && r.evidence.length > 0 && <pre>{JSON.stringify(r.evidence, null, 2)}</pre>}
          {r.required_for && r.required_for.length > 0 && <div className="caption">필요 대상: {r.required_for.join(', ')} · 입력 개정 {r.input_revision}</div>}
        </Disclosure>
      )}
    </div>
  )
  return (
    <div>
      <Toolbar title="검사 결과" sub={<SegmentedControl value={scope} options={[{ id: 'all', label: '전체 검사' }, { id: 'submission', label: '제출 후보 관문' }]} onChange={run} />} actions={<button onClick={() => { setRows(null); void refresh() }} disabled={loading}><Icon name="refresh" size={16} /> 새로고침</button>} />
      <p className="intro">{SCREEN_INTRO.checks}</p>
      {err && <Feedback kind={err.kind} title={err.title} body={err.action} details={<code>{err.raw}</code>} />}
      <div className="row" style={{ marginBottom: 'var(--sp-4)' }}>
        <select aria-label="상태" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}><option value="">상태: 전체</option><option value="pass">통과</option><option value="fail">실패</option><option value="blocked">보류</option><option value="not_configured">미설정</option></select>
        <select aria-label="심각도" value={filter.severity} onChange={(e) => setFilter({ ...filter, severity: e.target.value })}><option value="">심각도: 전체</option><option value="error">오류</option><option value="warning">경고</option></select>
        <select aria-label="담당" value={filter.owner} onChange={(e) => setFilter({ ...filter, owner: e.target.value })}><option value="">담당: 전체</option><option value="skill">스킬</option><option value="user">나</option><option value="professor">교수</option></select>
        <input aria-label="검색" placeholder="검사 이름·대상·사유 검색" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
        <span className="caption num">{shown.length} / {source.length}</span>
      </div>
      {shown.length === 0 && <EmptyState icon="search" title={EMPTY.checks_filtered.title} body={EMPTY.checks_filtered.body} />}
      {groups.map((g) => g.k === 'pass' ? (
        <Disclosure key={g.k} label={`통과 ${g.rows.length}건`}><div className="list">{g.rows.map((r, i) => <Row key={r.check_id + r.target + i} r={r} />)}</div></Disclosure>
      ) : (
        <div key={g.k}><div className="group-head">{g.label} {g.rows.length}</div><div className="list">{g.rows.map((r, i) => <Row key={r.check_id + r.target + i} r={r} />)}</div></div>
      ))}
      {rest.length > 0 && <div className="list" style={{ marginTop: 'var(--sp-3)' }}>{rest.map((r, i) => <Row key={r.check_id + r.target + i} r={r} />)}</div>}
      <p className="caption" style={{ marginTop: 'var(--sp-5)' }}>보류(blocked)는 '해당 없음'으로 바꿀 수 없어요. 근거를 등록하거나 에이전트에게 알려 주세요.</p>
    </div>
  )
}
