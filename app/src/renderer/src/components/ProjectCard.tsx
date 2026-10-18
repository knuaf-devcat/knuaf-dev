export function ProjectCard({ root, openedAt, exists, hasProject, onOpen, onRemove, index }: {
  root: string; openedAt: string; exists: boolean; hasProject: boolean; onOpen: () => void; onRemove: () => void; index: number
}) {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  const name = parts.pop() || root
  return (
    /* 한 줄 목록(시안 B, N-R02) — 이름 + 최근 시점, 기록 번호 칩은 뺐다. 제거는 줄 끝 작게. */
    <div className={`project ${exists ? '' : 'gone'}`} style={{ ['--i' as string]: index }} role="button" tabIndex={0} onClick={() => exists && onOpen()} onKeyDown={(e) => { if (e.key === 'Enter' && exists) onOpen() }}>
      <span className="name" title={root}>{name}</span>
      {!exists ? <span className="m">폴더 없음</span> : hasProject ? null : <span className="m">논문 시작 전</span>}
      <span className="m">{openedAt}</span>
      {/* 존재 여부와 무관하게 목록에서 뺄 수 있다 — 폴더 자체는 지우지 않는다. */}
      <button className="quiet" onClick={(e) => { e.stopPropagation(); onRemove() }}>목록에서 제거</button>
    </div>
  )
}
