import { useEffect, useState } from 'react'
import { useProject } from '../store/project'
import { CreditBanner, ErrorBanner } from '../components/Banners'

export function Home() {
  const { open, settings, error, loading } = useProject()
  const [showCredit, setShowCredit] = useState(false)
  useEffect(() => {
    if (settings && !settings.credit_shown_at) {
      setShowCredit(true)
      void window.knuaf.setSettings({ credit_shown_at: new Date().toISOString() })
    }
  }, [settings])
  const [typed, setTyped] = useState('')
  const pick = async () => { const dir = await window.knuaf.pickFolder(); if (dir) await open(dir) }
  return (
    <div>
      <h1>논문 작업 폴더</h1>
      {showCredit && <CreditBanner />}
      <p className="muted">이 앱은 에이전트(Codex / Claude Code)가 인터뷰하고 쓰는 동안 <b>저장 상태·검사 결과·다음 할 일·산출물</b>을 보여주고, 잠금이 남거나 정본이 꼬였을 때 복구를 돕습니다. JSON이나 명령어를 쓸 필요는 없습니다.</p>
      <ErrorBanner error={error} />
      <div className="row" style={{ margin: '16px 0' }}>
        <button className="primary" onClick={pick} disabled={loading}>폴더 열기…</button>
        <span className="muted">또는 경로 붙여넣기:</span>
        <input aria-label="폴더 경로" style={{ minWidth: 320 }} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="/Users/…/논문 작업" onKeyDown={(e) => { if (e.key === 'Enter' && typed) void open(typed) }} />
        <button onClick={() => typed && open(typed)} disabled={loading || !typed}>경로로 열기</button>
      </div>
      {settings && settings.recent.length > 0 && (
        <div>
          <h2>최근 폴더</h2>
          <div className="list">
            {settings.recent.map((r) => (
              <div key={r} className="item row" style={{ justifyContent: 'space-between' }}>
                <code>{r}</code>
                <button onClick={() => open(r)} disabled={loading}>열기</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
