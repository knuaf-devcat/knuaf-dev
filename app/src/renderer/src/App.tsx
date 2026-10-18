import React, { useEffect } from 'react'
import { useProject, type Screen } from './store/project'
import { useConnect } from './store/connect'
import { useChat } from './store/chat'
import { Chat } from './screens/Chat'
import { Materials } from './screens/Materials'
import { Artifacts } from './screens/Artifacts'
import { Checkup } from './screens/Checkup'
import { SettingsScreen } from './screens/Settings'
import { Onboarding } from './screens/Onboarding'
import { Shell } from './components/Shell'
import { Intro } from './components/Intro'
import { TitleBar } from './components/TitleBar'
import { Workspace } from './components/Workspace'
import { PaperPane } from './components/PaperPane'
import { Sheet } from './components/Sheet'
import { SheetOver } from './components/SheetOver'
import { showsPaper, useLayout } from './components/useLayout'
import { ARTIFACTS, CHECKUP, MATERIALS, SETTINGS } from './copy'
import { useShallow } from 'zustand/react/shallow'

/** 메뉴 막대(`main/menu.ts`)가 보낼 수 있는 화면 이름 — 'chat' 은 "시트를 닫아라"는 뜻이다. */
const SHEETS: Screen[] = ['materials', 'artifacts', 'checkup', 'settings']

/**
 * 앱 — 제목줄 하나, 작업 공간(대화 | 내 논문) 하나, 그 위에 덮이는 시트들 (IMPL-PLAN §4-5).
 *
 * v5에서 왼쪽 사이드바 목적지 다섯이 사라졌다: 내 논문은 작업 공간 자체가 됐고,
 * 자료·결과물·설정은 논문 위에 덮이는 한 장이며, 점검(제출 전 점검)은 논문 칸을 덮는
 * 한 장이다(시안 ⑫). 메뉴 막대의 같은 항목도 같은 시트를 연다 — 메뉴만 남아 다른 곳으로
 * 가면 두 진입점이 다른 화면을 보여 준다.
 */
export function App() {
  const { sheet, openSheet, closeSheet, root, settings, loadSettings, pushLog, open, paneView } = useProject(useShallow((s) => ({
    sheet: s.sheet, openSheet: s.openSheet, closeSheet: s.closeSheet, root: s.root, settings: s.settings,
    loadSettings: s.loadSettings, pushLog: s.pushLog, open: s.open, paneView: s.paneView
  })))
  const layout = useLayout()
  const [dragging, setDragging] = React.useState(false)
  /**
   * 여는 화면. 켤 때마다 뜨고, 누르거나 아무 키나 누르면 건너뛴다(`show_intro: false` 로 끈다).
   * 한 번 띄운 뒤로는 `shown` 이 막는다 — 설정이 나중에 바뀌어도 다시 뜨면 안 된다.
   */
  const [intro, setIntro] = React.useState(false)
  const shown = React.useRef(false)
  useEffect(() => {
    if (!settings || shown.current || settings.show_intro === false) return
    shown.current = true
    setIntro(true)
  }, [settings])
  useEffect(() => {
    void loadSettings()
    const h = location.hash.replace('#', '') as Screen
    if (SHEETS.includes(h)) openSheet(h)
    const off = window.knuaf.onSidecarLog(pushLog)
    const offChat = window.knuaf.onChatSnapshot((s) => useChat.getState().onSnapshot(s))
    const offMenu = window.knuaf.onMenu((a) => {
      const st = useProject.getState()
      if (a.type === 'open-folder') void window.knuaf.pickFolder().then((d) => { if (d) void st.open(d) })
      else if (a.type === 'open-recent' && a.root) void st.open(a.root)
      else if (a.type === 'refresh') void st.refresh()
      // 시트가 없는 화면 이름('chat')은 "대화로 돌아가기"다 — 논문은 언제나 깔려 있다.
      else if (a.type === 'settings') st.openSheet('settings')
      else if (a.type === 'ai-helper') st.closeSheet()
      else if (a.type === 'screen') {
        const name = a.screen as Screen
        if (SHEETS.includes(name)) st.openSheet(name)
        else st.closeSheet()
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
  const onboarding = !!settings && !root && !settings.onboarded_at
  // 학생이 고른 공급자는 설정에 남는다 — 세션 상태(store/connect)를 그 값과 맞춰 둔다.
  const choice = settings?.provider_choice?.provider ?? null
  useEffect(() => { useConnect.getState().select(choice) }, [choice])

  const paperOnScreen = showsPaper(layout, paneView)
  const checkup = sheet === 'checkup' && paperOnScreen
    ? <SheetOver open title={CHECKUP.sheetTitle} onClose={closeSheet}><Checkup /></SheetOver>
    : null

  return (
    <div style={{ height: '100%' }} onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={onDrop} data-dragging={dragging || undefined}>
      {intro && <Intro onDone={() => setIntro(false)} />}
      {!settings ? null : onboarding ? <Onboarding /> : (
        <Shell
          titleBar={<TitleBar />}
          sheets={<>
            {sheet === 'materials' && <Sheet open side title={MATERIALS.title} onClose={closeSheet}><Materials /></Sheet>}
            {sheet === 'artifacts' && <Sheet open side title={ARTIFACTS.title} onClose={closeSheet}><Artifacts /></Sheet>}
            {sheet === 'settings' && <Sheet open side title={SETTINGS.title} onClose={closeSheet}><SettingsScreen /></Sheet>}
            {sheet === 'checkup' && !paperOnScreen && <Sheet open side title={CHECKUP.sheetTitle} onClose={closeSheet}><Checkup /></Sheet>}
          </>}
        >
          <Workspace chat={<Chat />} paper={<PaperPane overlay={checkup} />} />
        </Shell>
      )}
    </div>
  )
}
