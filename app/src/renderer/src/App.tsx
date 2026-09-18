import React, { useEffect } from 'react'
import { useProject, type Screen } from './store/project'
import { Home } from './screens/Home'
import { Dashboard } from './screens/Dashboard'
import { Checks } from './screens/Checks'
import { Tasks } from './screens/Tasks'
import { Sections } from './screens/Sections'
import { Outputs } from './screens/Outputs'
import { Troubleshoot } from './screens/Troubleshoot'
import { SettingsScreen } from './screens/Settings'
import { IndependentReviewBanner } from './components/Banners'

const NAV: { id: Screen; label: string; needsProject?: boolean }[] = [
  { id: 'home', label: '홈' },
  { id: 'dashboard', label: '대시보드', needsProject: true },
  { id: 'checks', label: '검사 결과', needsProject: true },
  { id: 'tasks', label: '다음 할 일', needsProject: true },
  { id: 'sections', label: '절 목록', needsProject: true },
  { id: 'outputs', label: '산출물', needsProject: true },
  { id: 'troubleshoot', label: '문제 해결' },
  { id: 'settings', label: '설정' }
]

export function App() {
  const { screen, setScreen, root, hasProject, status, loadSettings, pushLog } = useProject()
  useEffect(() => {
    void loadSettings()
    const h = location.hash.replace('#', '') as Screen
    if (NAV.some((n) => n.id === h)) setScreen(h)
    const off = window.knuaf.onSidecarLog(pushLog)
    return () => { off() }
  }, [])
  const screens: Record<Screen, React.JSX.Element> = {
    home: <Home />, dashboard: <Dashboard />, checks: <Checks />, tasks: <Tasks />, sections: <Sections />,
    outputs: <Outputs />, troubleshoot: <Troubleshoot />, settings: <SettingsScreen />
  }
  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">knuaf-doc 동반 앱</div>
        <div className="root" title={root ?? ''}>{root ?? '폴더를 열어 주세요'}</div>
        {NAV.map((n) => (
          <button key={n.id} className={screen === n.id ? 'active' : ''} disabled={!!n.needsProject && !(root && hasProject)} onClick={() => setScreen(n.id)}>
            {n.label}
          </button>
        ))}
        <div className="spacer" />
        <div className="muted" style={{ fontSize: 12 }}>인터뷰와 작문은 에이전트 채팅에서, 저장·검사·발행은 이 앱에서.</div>
      </nav>
      <main className="main">
        {status && screen !== 'home' && <IndependentReviewBanner status={status} />}
        {screens[screen]}
      </main>
    </div>
  )
}
