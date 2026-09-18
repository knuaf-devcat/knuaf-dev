import { Icon, type IconName } from './Icon'
import type { Screen } from '../store/project'

export type NavItem = { id: Screen; label: string; icon: IconName; needsProject?: boolean }

export function Sidebar({ items, active, enabled, onSelect, onHelper, projectName, projectPath, revision }: {
  items: NavItem[]; active: Screen; enabled: boolean; onSelect: (s: Screen) => void; onHelper: () => void; projectName: string | null; projectPath: string | null; revision: number | null
}) {
  return (
    <nav className="sidebar" aria-label="화면">
      <div className="brand"><Icon name="mark" size={22} /><span>knuaf-doc</span></div>
      <div className="project-chip">
        {projectPath ? (<><div className="name">{projectName}{revision != null && <span className="caption"> · 개정 {revision}</span>}</div><div className="path" title={projectPath}>{projectPath}</div></>) : <div className="caption">폴더를 열어 주세요</div>}
      </div>
      {items.map((n) => (
        <button key={n.id} className={`nav-item ${active === n.id ? 'active' : ''}`} disabled={!!n.needsProject && !enabled} title={n.needsProject && !enabled ? '먼저 폴더를 여세요' : undefined} onClick={() => onSelect(n.id)} aria-current={active === n.id ? 'page' : undefined}>
          <Icon name={n.icon} />{n.label}
        </button>
      ))}
      <div className="spacer" />
      <button className="primary helper-btn" onClick={onHelper} disabled={!projectPath} title={projectPath ? undefined : '먼저 폴더를 여세요'}><Icon name="arrow" /> AI 도우미 열기</button>
      <div className="foot">인터뷰와 작문은 에이전트 채팅에서, 저장·검사·발행은 이 앱에서.</div>
    </nav>
  )
}
