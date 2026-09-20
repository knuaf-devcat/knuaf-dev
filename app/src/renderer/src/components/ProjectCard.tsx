import { Badge } from './Badge'

export function ProjectCard({ root, openedAt, revision, exists, hasProject, onOpen, onRemove, index }: {
  root: string; openedAt: string; revision: number | null; exists: boolean; hasProject: boolean; onOpen: () => void; onRemove: () => void; index: number
}) {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  const name = parts.pop() || root
  // 학생에게는 경로 끝부분만(03-화면/01) — 전체 경로는 title tooltip에만.
  const tail = parts.length > 0 ? `…/${parts.at(-1)}/${name}` : name
  return (
    <div className={`project ${exists ? '' : 'gone'}`} style={{ ['--i' as string]: index }} role="button" tabIndex={0} onClick={() => exists && onOpen()} onKeyDown={(e) => { if (e.key === 'Enter' && exists) onOpen() }}>
      <div className="name"><span>{name}</span>{!exists ? <Badge label="폴더 없음" /> : hasProject ? <Badge tone="accent" label={`${revision ?? 0}번째 기록`} /> : <Badge label="논문 시작 전" />}</div>
      <div className="path" title={root}>{tail}</div>
      <div className="row between"><span className="caption">{openedAt}</span>{/* 존재 여부와 무관하게 목록에서 뺄 수 있다 — 폴더 자체는 지우지 않는다. */}
      <button className="quiet" onClick={(e) => { e.stopPropagation(); onRemove() }}>목록에서 제거</button></div>
    </div>
  )
}
