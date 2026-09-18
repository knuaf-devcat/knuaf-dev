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
import { Shell } from './components/Shell'
import { Sidebar, type NavItem } from './components/Sidebar'
import { Feedback } from './components/Feedback'
import { HelperSheet } from './components/HelperSheet'
import { INDEPENDENT_REVIEW_MISSING } from './copy'

const NAV: NavItem[] = [
  { id: 'home', label: '홈', icon: 'folder' },
  { id: 'dashboard', label: '대시보드', icon: 'layout', needsProject: true },
  { id: 'checks', label: '검사 결과', icon: 'check', needsProject: true },
  { id: 'tasks', label: '다음 할 일', icon: 'list', needsProject: true },
  { id: 'sections', label: '절 목록', icon: 'doc', needsProject: true },
  { id: 'outputs', label: '산출물', icon: 'box', needsProject: true },
  { id: 'troubleshoot', label: '문제 해결', icon: 'wrench' },
  { id: 'settings', label: '설정', icon: 'gear' }
]

export function App() {
  const { screen, setScreen, root, hasProject, status, loadSettings, pushLog, open, refresh } = useProject()
  const [dragging, setDragging] = React.useState(false)
  useEffect(() => {
    void loadSettings()
    const h = location.hash.replace('#', '') as Screen
    if (NAV.some((n) => n.id === h) && !NAV.find((n) => n.id === h)?.needsProject) setScreen(h)
    const off = window.knuaf.onSidecarLog(pushLog)
    const offMenu = window.knuaf.onMenu((a) => {
      const st = useProject.getState()
      if (a.type === 'open-folder') void window.knuaf.pickFolder().then((d) => { if (d) void st.open(d) })
      else if (a.type === 'open-recent' && a.root) void st.open(a.root)
      else if (a.type === 'refresh') void st.refresh()
      else if (a.type === 'settings') st.setScreen('settings')
      else if (a.type === 'ai-helper') void st.openHelper()
      else if (a.type === 'screen' && a.screen) {
        const item = NAV.find((n) => n.id === a.screen)
        if (item && (!item.needsProject || (st.root && st.hasProject))) st.setScreen(item.id)
      }
    })
    return () => { off(); offMenu() }
  }, [])
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]
    if (!f) return
    const p = window.knuaf.pathForFile(f)
    if (await window.knuaf.isDir(p)) await open(p)
  }
  void refresh
  const screens: Record<Screen, React.JSX.Element> = {
    home: <Home />, dashboard: <Dashboard />, checks: <Checks />, tasks: <Tasks />, sections: <Sections />,
    outputs: <Outputs />, troubleshoot: <Troubleshoot />, settings: <SettingsScreen />
  }
  const name = root ? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? root : null
  const banner = status && screen !== 'home' && status.lanes.content_review.independent_review_missing
  return (
    <div style={{ height: '100%' }} onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={onDrop} data-dragging={dragging || undefined}>
    <Shell screenKey={screen} sidebar={<Sidebar items={NAV} active={screen} enabled={!!(root && hasProject)} onSelect={(s) => setScreen(s)} onHelper={() => void useProject.getState().openHelper()} projectName={name} projectPath={root} revision={status?.revision ?? null} />}>
      {banner && <div className="banner-top"><Feedback kind="warning" title={INDEPENDENT_REVIEW_MISSING.title} body={INDEPENDENT_REVIEW_MISSING.body} /></div>}
      {screens[screen]}
      <HelperSheet />
    </Shell>
    </div>
  )
}
