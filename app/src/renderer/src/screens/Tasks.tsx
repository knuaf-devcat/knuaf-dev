import { useProject } from '../store/project'
import { Toolbar } from '../components/Toolbar'
import { Badge, StatusBadge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { EMPTY, SCREEN_INTRO } from '../copy'

export function Tasks() {
  const { status, refresh, loading } = useProject()
  if (!status) return null
  const groups = [['needs_user', '내 답변이 필요한 일', 'tasks_needs_user'], ['needs_evidence', '근거가 필요한 일', 'tasks_needs_evidence'], ['ready', '진행 가능한 일', 'tasks_ready']] as const
  const all = status.tasks.length
  return (
    <div>
      <Toolbar title="다음 할 일" sub={<Badge label={`${all}건`} />} actions={<button onClick={refresh} disabled={loading}><Icon name="refresh" size={16} /> 새로고침</button>} />
      <p className="intro">{SCREEN_INTRO.tasks}</p>
      {all === 0 && <EmptyState icon="done" title={EMPTY.tasks_all.title} body={EMPTY.tasks_all.body} />}
      {all > 0 && groups.map(([key, label, emptyKey]) => {
        const rows = status.tasks.filter((t) => t.status === key)
        return (
          <div key={key}>
            <h2>{label} <span className="muted num">{rows.length}</span></h2>
            {rows.length === 0 ? <div className="caption">{EMPTY[emptyKey].title}</div> : (
              <div className="list">
                {rows.map((t) => (
                  <div key={t.id} className="item">
                    <div className="head"><strong>{t.id}</strong><StatusBadge status={t.status} /></div>
                    {t.missing && t.missing.length > 0 && <div className="row" style={{ marginTop: 'var(--sp-2)' }}><span className="caption">부족한 항목</span>{t.missing.map((m) => <Badge key={m} label={m} />)}</div>}
                    {t.reason && <div className="reason">{t.reason}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
