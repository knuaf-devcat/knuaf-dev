import { useState } from 'react'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import type { Settings } from '../../../shared/types'

export function ProjectSidebar() {
  const [drawer, setDrawer] = useState(false)
  const root = useProject((s) => s.root)
  const recent = useProject((s) => s.settings?.recent ?? [])
  const loading = useProject((s) => s.loading)
  const open = useProject((s) => s.open)
  const busy = useChat((s) => s.busy || s.snapshot?.state === 'running' || s.snapshot?.state === 'permission')
  const start = (): void => {
    if (busy || loading) return
    useProject.setState({
      root: null, hasProject: false, status: null, peek: null, sidecar: null, depsReady: null,
      sections: null, materials: null, artifacts: null, buildTree: null, projectLoad: null,
      events: [], focusedSection: null, paneView: 'chat', error: null, openFailure: null, retryFailed: null
    })
    useProject.getState().closeSheet()
    setDrawer(false)
  }
  const pick = async (): Promise<void> => {
    const dir = await window.knuaf.pickFolder()
    if (dir) await open(dir)
    setDrawer(false)
  }
  const remove = async (path: string): Promise<void> => {
    const current = await window.knuaf.getSettings() as Settings
    await window.knuaf.setSettings({ recent: current.recent.filter((item) => item.root !== path) })
    await useProject.getState().loadSettings()
  }
  return <>
    <button className="project-drawer-toggle" aria-label="프로젝트 목록" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>☰</button>
    {drawer && <button className="project-drawer-backdrop" aria-label="프로젝트 목록 닫기" onClick={() => setDrawer(false)} />}
    <aside className={`project-sidebar${drawer ? ' open' : ''}`} aria-label="프로젝트">
      <button className="project-nav" onClick={start} disabled={!!busy || loading}>새 논문 시작</button>
      <div className="project-sidebar-label">프로젝트(논문)</div>
      {recent.map((r) => <div key={r.root} className="project-entry">
        <button className={`project-nav${root === r.root ? ' selected' : ''}`} title={r.root} onClick={() => { void open(r.root); setDrawer(false) }}>
          {r.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || r.root}
        </button>
        <button className="project-remove" aria-label={`목록에서 제거: ${r.root}`} onClick={() => void remove(r.root)}>×</button>
      </div>)}
      <button className="project-nav" onClick={() => void pick()}>+ 논문 추가</button>
    </aside>
  </>
}
