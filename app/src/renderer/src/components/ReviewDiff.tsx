import { renderMarkdown } from '../markdown'
import { sectionDiff } from '../../../shared/diff'

/**
 * 발주 QA2-B · N-I04 — "고친 부분 보기"가 켜졌을 때 절 하나를 그린다.
 *
 * 같은 문단은 마크다운 그대로(표·목록·제목이 살아 있다), 바뀐 문단은 문장 단위로 갈라 지운
 * 문장(빨강 취소선)·새 문장(초록 바탕)을 인라인으로 칠한다. 통째로 지운/새로 쓴 문단은
 * 그 문단을 마크다운으로 그리되 `del`/`ins` 상자로 감싼다 — **마크다운 렌더 경로를 그대로 쓴다.**
 */
export function ReviewDiffBlocks({ before, after }: { before: string; after: string }) {
  const blocks = sectionDiff(before, after)
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === 'segs') {
          return (
            <div key={i} className="blk rev-segs">
              {b.segs.map((s, j) => s.kind === 'del'
                ? <del key={j} className="rev-del">{s.text} </del>
                : s.kind === 'ins'
                  ? <ins key={j} className="rev-ins">{s.text} </ins>
                  : <span key={j}>{s.text} </span>)}
            </div>
          )
        }
        return <div key={i} className={b.kind === 'same' ? 'blk' : `blk rev-${b.kind}`}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(b.markdown) }} />
      })}
    </>
  )
}
