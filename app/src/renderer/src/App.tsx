import React, { useEffect } from 'react'
import { useProject, type Screen } from './store/project'
import { useChat } from './store/chat'
import { Chat } from './screens/Chat'
import { Materials } from './screens/Materials'
import { Artifacts } from './screens/Artifacts'
import { Checkup } from './screens/Checkup'
import { SettingsScreen } from './screens/Settings'
import { Shell } from './components/Shell'
import { Intro } from './components/Intro'
import { Sidebar, type NavItem } from './components/Sidebar'
import { NAV } from './copy'
import { useShallow } from 'zustand/react/shallow'

/** The five destinations — 도구·문제 해결·절 목록은 설정과 사이드바 차례로 흡수됐다(06 4단계). */
const NAV_ITEMS: NavItem[] = [
  // 폴더 없음도 내 논문의 한 상태 — 프로젝트 없이도 항상 열려 있는 유일한 목적지(03-화면/01).
  { id: 'chat', label: NAV.thesis, icon: 'doc' },
  { id: 'materials', label: NAV.materials, icon: 'files', needsProject: true },
  { id: 'artifacts', label: NAV.artifacts, icon: 'box', needsProject: true },
  { id: 'checkup', label: NAV.checkup, icon: 'check', needsProject: true },
  { id: 'settings', label: NAV.settings, icon: 'gear' }
]

export function App() {
  const { screen, setScreen, root, hasProject, status, settings, loadSettings, pushLog, open } = useProject(useShallow((s) => ({ screen: s.screen, setScreen: s.setScreen, root: s.root, hasProject: s.hasProject, status: s.status, settings: s.settings, loadSettings: s.loadSettings, pushLog: s.pushLog, open: s.open })))
  const [dragging, setDragging] = React.useState(false)
  /**
   * 첫 실행 여는 화면. 크레딧을 "내 논문" 화면 안쪽 점선 상자로 얹어 두던 것을
   * 앱 전체 위로 올렸다 — 처음 여는 순간에 한 번만 보이고, 본 사실은 그 자리에서
   * 기록해 다시 뜨지 않는다(설정의 credit_shown_at).
   */
  const [intro, setIntro] = React.useState(false)
  useEffect(() => {
    if (!settings || settings.credit_shown_at) return
    setIntro(true)
    void window.knuaf.setSettings({ credit_shown_at: new Date().toISOString() })
  }, [settings])
  useEffect(() => {
    void loadSettings()
    const h = location.hash.replace('#', '') as Screen
    if (NAV_ITEMS.some((n) => n.id === h && !n.needsProject)) setScreen(h)
    const off = window.knuaf.onSidecarLog(pushLog)
    const offChat = window.knuaf.onChatSnapshot((s) => useChat.getState().onSnapshot(s))
    const offMenu = window.knuaf.onMenu((a) => {
      const st = useProject.getState()
      if (a.type === 'open-folder') void window.knuaf.pickFolder().then((d) => { if (d) void st.open(d) })
      else if (a.type === 'open-recent' && a.root) void st.open(a.root)
      else if (a.type === 'refresh') void st.refresh()
      else if (a.type === 'settings') st.setScreen('settings')
      else if (a.type === 'ai-helper') { if (st.root) st.setScreen('chat') }
      else if (a.type === 'screen' && a.screen) {
        const item = NAV_ITEMS.find((n) => n.id === a.screen)
        if (item && (!item.needsProject || (st.root && st.hasProject))) st.setScreen(item.id)
      }
    })
    return () => { off(); offChat(); offMenu() }
  }, [])
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]
    if (!f) return
    const p = window.knuaf.pathForFile(f)
    if (await window.knuaf.isDir(p)) await open(p)
  }
  const screens: Record<Screen, React.JSX.Element> = {
    chat: <Chat />, materials: <Materials />, artifacts: <Artifacts />, checkup: <Checkup />, settings: <SettingsScreen />
  }
  const name = root ? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? root : null
  return (
    <div style={{ height: '100%' }} onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={onDrop} data-dragging={dragging || undefined}>
    {intro && <Intro onDone={() => setIntro(false)} />}
    <Shell screenKey={screen} sidebar={<Sidebar items={NAV_ITEMS} active={screen} enabled={!!(root && hasProject)} onSelect={(s) => setScreen(s)} projectName={name} projectPath={root} revision={status?.revision ?? null} />}>
      {screens[screen]}
    </Shell>
    </div>
  )
}
