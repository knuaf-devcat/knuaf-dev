import { useEffect, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { CatMark } from './CatMark'
import { rpc } from '../rpc'
import { Sheet } from './Sheet'
import { Badge } from './Badge'
import { APP_NAME_KO, APP_NAME_SHORT } from '../../../shared/name'
import { NAV, READ_ONLY_NOTE, STATUS_LABEL } from '../copy'
import type { Screen } from '../store/project'
import type { SectionRow } from '../../../shared/types'

export type NavItem = { id: Screen; label: string; icon: IconName; needsProject?: boolean }

function NavButton({ n, active, enabled, onSelect }: { n: NavItem; active: Screen; enabled: boolean; onSelect: (s: Screen) => void }) {
  return (
    <button className={`nav-item ${active === n.id ? 'active' : ''}`} disabled={!!n.needsProject && !enabled} title={n.needsProject && !enabled ? '먼저 폴더를 여세요' : undefined} onClick={() => onSelect(n.id)} aria-current={active === n.id ? 'page' : undefined}>
      <Icon name={n.icon} />{n.label}
    </button>
  )
}

/** drafting → accent, empty → outline, anything else (review_ready 등) → neutral ink (04-토큰diff §4). */
function tocDot(status: string): string {
  if (status === 'drafting') return 'drafting'
  if (status === 'empty') return 'empty'
  return 'filled'
}

export function Sidebar({ items, active, enabled, onSelect, projectName, projectPath, revision }: {
  items: NavItem[]; active: Screen; enabled: boolean; onSelect: (s: Screen) => void; projectName: string | null; projectPath: string | null; revision: number | null
}) {
  const [sections, setSections] = useState<SectionRow[] | null>(null)
  const [sel, setSel] = useState<{ id: string; title: string; draft: string } | null>(null)
  // 논문 차례는 정본을 읽는 목록 — revision이 오르면 다시 읽는다(읽기 전용, 쓰기 없음).
  useEffect(() => {
    if (!projectPath || !enabled) { setSections(null); return }
    let alive = true
    void rpc.sections(projectPath).then((s) => { if (alive) setSections(s) }).catch(() => { if (alive) setSections(null) })
    return () => { alive = false }
  }, [projectPath, enabled, revision])
  const openSection = async (id: string) => { if (!projectPath) return; try { setSel(await rpc.readSection(projectPath, id)) } catch { /* missing section — row stays */ } }
  return (
    <nav className="sidebar" aria-label="화면">
      {/* 224px 사이드바에 한 줄로는 안 들어간다. 가운뎃점은 한 줄일 때 쓰는 구분자라
          줄을 나누면 첫 줄 끝에 대롱대롱 매달리므로 여기서는 빼고 두 줄로 앉힌다. */}
      <div className="brand"><CatMark size={22} /><span><b>{APP_NAME_SHORT}</b>{APP_NAME_KO}</span></div>
      <div className="project-chip">
        {projectPath ? <div className="name" title={projectPath}>{projectName}{/* revision rises on every apply (gg_core.py:872), including the agent's — not only
            on something the student did, so "저장"(학생 행위)이 아니라 "기록". */}
          {revision != null && <span className="caption"> · {revision}번째 기록</span>}</div> : <div className="caption">폴더를 열어 주세요</div>}
      </div>
      {items.map((n) => <NavButton key={n.id} n={n} active={active} enabled={enabled} onSelect={onSelect} />)}
      {enabled && sections !== null && (
        <div className="toc" aria-label={NAV.tocHead}>
          <div className="toc-head">{NAV.tocHead}</div>
          {sections.length === 0
            ? <div className="toc-empty caption">{NAV.tocNone}</div>
            : sections.map((s) => (
              <button key={s.id} className="toc-item" onClick={() => void openSection(s.id)}>
                <span className={`toc-dot ${tocDot(s.status)}`} aria-hidden="true" />
                <span className="t">{s.order}. {s.title}</span>
                <span className="st">{s.status === 'empty' ? NAV.tocNone : STATUS_LABEL[s.status] ?? s.status}</span>
              </button>
            ))}
        </div>
      )}
      <div className="spacer" />
      <Sheet open={!!sel} side title={sel?.title ?? ''} badge={<Badge label="읽기 전용" />} onClose={() => setSel(null)}>
        <p className="caption">{READ_ONLY_NOTE}</p>
        <div className="prose">{sel?.draft}</div>
      </Sheet>
    </nav>
  )
}
