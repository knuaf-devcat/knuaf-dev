import { useProject } from '../store/project'
import { StatusPill } from '../components/Pills'

export function Tasks() {
  const { status, refresh, loading } = useProject()
  if (!status) return null
  const groups = { needs_user: '내 답변이 필요한 일', needs_evidence: '근거가 필요한 일', ready: '진행 가능한 일' } as const
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}><h1>다음 할 일</h1><button onClick={refresh} disabled={loading}>새로고침</button></div>
      <p className="muted">질문에는 에이전트 채팅에서 답합니다. 이 화면은 무엇이 막혀 있는지 보여주기만 합니다.</p>
      {Object.entries(groups).map(([key, label]) => {
        const rows = status.tasks.filter((t) => t.status === key)
        return (
          <div key={key}>
            <h2>{label} <span className="muted">{rows.length}</span></h2>
            <div className="list">
              {rows.length === 0 && <div className="item muted">없음</div>}
              {rows.map((t) => (
                <div key={t.id} className="item">
                  <div className="head"><strong>{t.id}</strong><StatusPill status={t.status} /></div>
                  {t.missing && t.missing.length > 0 && <div className="reason">부족한 항목: {t.missing.join(', ')}</div>}
                  {t.reason && <div className="reason">{t.reason}</div>}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
