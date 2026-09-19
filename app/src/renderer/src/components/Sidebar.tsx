import { useState } from 'react'
import { Icon, type IconName } from './Icon'
import type { Screen } from '../store/project'

export type NavItem = { id: Screen; label: string; icon: IconName; needsProject?: boolean }
export type NavGroup = { id: string; label: string; items: NavItem[] }

function NavButton({ n, active, enabled, onSelect, nested }: { n: NavItem; active: Screen; enabled: boolean; onSelect: (s: Screen) => void; nested?: boolean }) {
  return (
    <button className={`nav-item ${active === n.id ? 'active' : ''} ${nested ? 'nested' : ''}`} disabled={!!n.needsProject && !enabled} title={n.needsProject && !enabled ? '먼저 폴더를 여세요' : undefined} onClick={() => onSelect(n.id)} aria-current={active === n.id ? 'page' : undefined}>
      <Icon name={n.icon} />{n.label}
    </button>
  )
}

export function Sidebar({ items, groups = [], active, enabled, onSelect, projectName, projectPath, revision }: {
  items: NavItem[]; groups?: NavGroup[]; active: Screen; enabled: boolean; onSelect: (s: Screen) => void; projectName: string | null; projectPath: string | null; revision: number | null
}) {
  // Collapsed groups stay closed across launches (localStorage knuaf-nav-<id>); an active
  // screen inside a closed group is marked with a dot on the group label.
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const g of groups) {
      try { init[g.id] = localStorage.getItem(`knuaf-nav-${g.id}`) === '1' } catch { init[g.id] = false }
    }
    return init
  })
  const toggle = (id: string) => {
    setOpen((s) => {
      const next = { ...s, [id]: !s[id] }
      try { localStorage.setItem(`knuaf-nav-${id}`, next[id] ? '1' : '0') } catch { /* private mode */ }
      return next
    })
  }
  return (
    <nav className="sidebar" aria-label="화면">
      <div className="brand"><Icon name="mark" size={22} /><span>knuaf-doc</span></div>
      <div className="project-chip">
        {projectPath ? (<><div className="name">{projectName}{revision != null && <span className="caption"> · 개정 {revision}</span>}</div><div className="path" title={projectPath}>{projectPath}</div></>) : <div className="caption">폴더를 열어 주세요</div>}
      </div>
      {items.map((n) => <NavButton key={n.id} n={n} active={active} enabled={enabled} onSelect={onSelect} />)}
      {groups.map((g) => {
        const isOpen = !!open[g.id]
        const containsActive = g.items.some((n) => n.id === active)
        return (
          <div key={g.id} className="nav-group">
            <button className={`nav-item nav-group-label ${!isOpen && containsActive ? 'active' : ''}`} onClick={() => toggle(g.id)} aria-expanded={isOpen}>
              <Icon name="chevron" style={{ transform: isOpen ? 'rotate(90deg)' : undefined, transition: 'transform 160ms ease-out' }} />{g.label}
              {!isOpen && containsActive && <span className="dot" aria-hidden="true" />}
            </button>
            {isOpen && g.items.map((n) => <NavButton key={n.id} n={n} active={active} enabled={enabled} onSelect={onSelect} nested />)}
          </div>
        )
      })}
      <div className="spacer" />
      <button className="primary helper-btn" onClick={() => onSelect('chat')} disabled={!projectPath} title={projectPath ? undefined : '먼저 폴더를 여세요'}><Icon name="arrow" /> 내 논문으로</button>
      <div className="foot">인터뷰와 작문은 에이전트 채팅에서, 저장·검사·발행은 이 앱에서.</div>
    </nav>
  )
}
