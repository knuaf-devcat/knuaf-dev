import React, { useEffect } from 'react'
import { useProject, type Screen } from './store/project'
import { connInfoOf, useConnect } from './store/connect'
import { useChat } from './store/chat'
import { Chat } from './screens/Chat'
import { Materials } from './screens/Materials'
import { Artifacts } from './screens/Artifacts'
import { Checkup } from './screens/Checkup'
import { SettingsScreen } from './screens/Settings'
import { Shell } from './components/Shell'
import { TitleBar } from './components/TitleBar'
import { Workspace } from './components/Workspace'
import { PaperPane } from './components/PaperPane'
import { Sheet } from './components/Sheet'
import { SheetOver } from './components/SheetOver'
import { showsPaper, useLayout } from './components/useLayout'
import { ARTIFACTS, CHECKUP, MATERIALS, SETTINGS } from './copy'
import { useShallow } from 'zustand/react/shallow'
import type { Provider } from '../../shared/chat'

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
  useEffect(() => {
    const targets = new Set<Provider>()
    let saving = false
    let fromChat = false
    const offChat = useChat.subscribe((state, before) => {
      if (!state.root || state.connState === 'checking') return
      if (state.status === before.status && state.statusFailed === before.statusFailed && state.connState === before.connState) return
      const info = state.statusFailed || !state.status
        ? { state: state.connState, detail: state.error ?? '', version: null }
        : connInfoOf(state.status)
      fromChat = true
      try { useConnect.getState().observeChat(state.provider, info) } finally { fromChat = false }
    })
    const offConnect = useConnect.subscribe((state, before) => {
      for (const p of ['codex', 'claude'] as const) {
        if (state.loggingIn[p]) targets.add(p)
        if (!fromChat && state[p].state !== before[p].state && state[p].state !== 'checking') {
          const chat = useChat.getState()
          if (chat.root && chat.provider === p) void chat.refreshStatus()
        }
        if (state[p].state === 'connected' && before[p].state !== 'connected') {
          if (targets.has(p) && !saving && (!state.selected || state[state.selected].state !== 'connected')) {
            saving = true
            void window.knuaf.setSettings({ helper_mode: p === 'claude' ? 'claude-chat' : 'codex-chat', provider_choice: { provider: p, at: new Date().toISOString() } })
              .then(() => { useConnect.getState().select(p); return useProject.getState().loadSettings() })
              .finally(() => { saving = false })
          }
          targets.delete(p)
        } else if (!state.loggingIn[p] && before.loggingIn[p]) targets.delete(p)
      }
    })
    return () => { offChat(); offConnect() }
  }, [])
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
  // 학생이 고른 공급자는 설정에 남는다 — 세션 상태(store/connect)를 그 값과 맞춰 둔다.
  const choice = settings?.provider_choice?.provider ?? null
  useEffect(() => { useConnect.getState().select(choice) }, [choice])
  /**
   * 제목줄의 계정 자리가 "● ChatGPT 연결됨"을 말하려면 앱이 연결 상태를 **봐야** 한다 —
   * 보지 않고 두면 그 자리는 영원히 "확인 중"이거나 "연결 안 됨"이 된다(관찰한 것만 말한다).
   * 첫 실행 화면이 떠 있으면 그 화면이 스스로 확인하므로 여기서는 겹치지 않게 건너뛴다.
   */
  const looked = React.useRef(false)
  useEffect(() => {
    if (!settings || looked.current) return
    // 연결 확인은 폴더와 무관하게 앱 시작 시 한 번 한다.
    looked.current = true
    void useConnect.getState().refreshAll()
  }, [settings, root])

  const paperOnScreen = showsPaper(layout, paneView)
  const checkup = sheet === 'checkup' && paperOnScreen
    ? <SheetOver open screen="checkup" title={CHECKUP.sheetTitle} onClose={closeSheet}><Checkup /></SheetOver>
    : null

  return (
    <div style={{ height: '100%' }} onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={onDrop} data-dragging={dragging || undefined}>
      {!settings ? null : (
        <Shell
          titleBar={<TitleBar />}
          sheets={<>
            {sheet === 'materials' && <Sheet open side screen="materials" title={MATERIALS.title} onClose={closeSheet}><Materials /></Sheet>}
            {sheet === 'artifacts' && <Sheet open side screen="artifacts" title={ARTIFACTS.title} onClose={closeSheet}><Artifacts /></Sheet>}
            {sheet === 'settings' && <Sheet open side screen="settings" title={SETTINGS.title} onClose={closeSheet}><SettingsScreen /></Sheet>}
            {sheet === 'checkup' && !paperOnScreen && <Sheet open side screen="checkup" title={CHECKUP.sheetTitle} onClose={closeSheet}><Checkup /></Sheet>}
          </>}
        >
          <Workspace chat={<Chat />} paper={<PaperPane overlay={checkup} />} />
        </Shell>
      )}
    </div>
  )
}
