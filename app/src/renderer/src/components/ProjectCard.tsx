import { Badge } from './Badge'

export function ProjectCard({ root, openedAt, revision, exists, hasProject, onOpen, onRemove, index }: {
  root: string; openedAt: string; revision: number | null; exists: boolean; hasProject: boolean; onOpen: () => void; onRemove: () => void; index: number
}) {
  const name = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root
  return (
    <div className={`project ${exists ? '' : 'gone'}`} style={{ ['--i' as string]: index }} role="button" tabIndex={0} onClick={() => exists && onOpen()} onKeyDown={(e) => { if (e.key === 'Enter' && exists) onOpen() }}>
      <div className="name"><span>{name}</span>{!exists ? <Badge label="폴더 없음" /> : hasProject ? <Badge tone="accent" label={`개정 ${revision ?? 0}`} /> : <Badge label="정본 없음" />}</div>
      <div className="path" title={root}>{root}</div>
      <div className="row between"><span className="caption">{openedAt}</span>{!exists && <button className="quiet" onClick={(e) => { e.stopPropagation(); onRemove() }}>목록에서 제거</button>}</div>
    </div>
  )
}
