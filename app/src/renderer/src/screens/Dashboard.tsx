import { useProject } from '../store/project'
import { Toolbar } from '../components/Toolbar'
import { Feedback } from '../components/Feedback'
import { Lane } from '../components/Lane'
import { Stat, Stats } from '../components/Stat'
import { Badge, StatusBadge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { COLLECTION_LABEL, EMPTY, LANE_COPY, REVIEW_KIND_LABEL, SCREEN_INTRO, USER_FINISH_LABEL } from '../copy'
import type { LaneSummary } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'

function Counts({ s }: { s: LaneSummary }) {
  return <Stats><Stat value={s.pass} label="통과" tone="ok" /><Stat value={s.fail} label="실패" tone={s.fail ? 'bad' : undefined} /><Stat value={s.blocked} label="보류" tone={s.blocked ? 'blocked' : undefined} />{s.other > 0 && <Stat value={s.other} label="기타" />}</Stats>
}

/** SKILL.md:34 — four lanes, never one checkmark, never a percentage. */
export function Dashboard() {
  const { status, refresh, loading, error, setScreen } = useProject(useShallow((s) => ({ status: s.status, refresh: s.refresh, loading: s.loading, error: s.error, setScreen: s.setScreen })))
  const [L1, L2, L3, L4] = LANE_COPY
  return (
    <div>
      <Toolbar title="대시보드" sub={status && <Badge label={`개정 ${status.revision}`} />} actions={<button onClick={refresh} disabled={loading}><Icon name="refresh" size={16} /> {loading ? '읽는 중…' : '새로고침'}</button>} />
      <p className="intro">{SCREEN_INTRO.dashboard}</p>
      {error && <Feedback kind={error.kind} title={error.title} body={error.action} details={<code>{error.raw}</code>} />}
      {status && (
        <>
          <div className="grid-2 lanes stagger">
            <Lane number={L1.number} title={L1.title} badge={status.lanes.machine.ready ? <StatusBadge status="pass" label="검사 완료" /> : <StatusBadge status="blocked" label="진행 중" />} description={status.lanes.machine.ready ? L1.readyText : L1.notReadyText} foot={<button onClick={() => setScreen('checks', { owner: 'skill' })}>자세히</button>}>
              <Counts s={status.lanes.machine.summary} />
            </Lane>
            <Lane number={L2.number} title={L2.title} description={L2.description} foot={<button onClick={() => setScreen('checks', { prefix: 'review_' })}>자세히</button>}>
              <div className="row">{Object.entries(status.lanes.content_review.by_kind).map(([k, v]) => <StatusBadge key={k} status={v} label={REVIEW_KIND_LABEL[k] ?? k} />)}</div>
              {status.lanes.content_review.independent_review_missing && <div className="caption">{L2.notReadyText}</div>}
            </Lane>
            <Lane number={L3.number} title={L3.title} description={L3.description} foot={<button onClick={() => setScreen('checks', { prefix: 'output_' })}>자세히</button>}>
              <Counts s={status.lanes.output_review.summary} />
              <div className="caption">학교 지침 준비: {status.lanes.output_review.guideline_ready === null ? '미설정' : status.lanes.output_review.guideline_ready ? '준비됨' : '미완'}</div>
            </Lane>
            <Lane number={L4.number} title={L4.title} badge={status.lanes.professor.recorded ? <Badge tone="accent" label="기록 있음" /> : <Badge label="기록 없음" />} description={L4.description}>
              <div className="caption">{status.lanes.professor.recorded ? L4.readyText : L4.notReadyText}</div>
            </Lane>
          </div>
          <h2>한글에서 마무리할 일</h2>
          <p className="caption">사람이 직접 확인하는 일이에요. Ⅰ~Ⅵ 작성이나 DOCX/XLSX 작업을 막지 않아요.</p>
          {status.user_finish_pending.length === 0 ? <EmptyState icon="done" title={EMPTY.user_finish.title} body={EMPTY.user_finish.body} /> : (
            <div className="list">{status.user_finish_pending.map((u) => <div key={u.id} className="item"><div className="head"><strong>{USER_FINISH_LABEL[u.id] ?? u.id}</strong><StatusBadge status={u.status} /></div><div className="reason">{u.reason}</div></div>)}</div>
          )}
          <h2>등록 현황</h2>
          <Stats>{Object.entries(status.counts).map(([k, v]) => <Stat key={k} value={v} label={COLLECTION_LABEL[k] ?? k} />)}</Stats>
          <p className="caption" style={{ marginTop: 'var(--sp-4)' }}>{status.completion.notice}</p>
        </>
      )}
    </div>
  )
}
