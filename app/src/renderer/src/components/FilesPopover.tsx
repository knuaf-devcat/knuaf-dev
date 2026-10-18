import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Icon } from './Icon'
import { PopHead, Popover, PopRow, PopSep } from './Popover'
import { useProject } from '../store/project'
import { ARTIFACTS, FILES_POPOVER, PAPER } from '../copy'
import { joinPath } from '../paths'
import { fileStateOf, isReviewExport } from '../../../shared/files'
import type { Make } from './useMake'
import { useStage } from './useStage'

/**
 * 파일 팝오버 (시안 ⑩⑮) — 종이 머리의 "파일 N".
 *
 * 위: **만들기 4줄**(v2 §4-2의 입력 조건 그대로 — "지금"이 권하는 단추와 다르다).
 * 아래: 만든 파일 목록. 파일마다 "지금 논문과 같은지" 한 줄로 말한다.
 *
 * 여기서 `useMake()` 를 쓴다 — 점검 시트·결과물 전체 화면과 같은 코드다(IMPL-PLAN §4-5).
 * 파일 현재성 점은 `project.load` 의 `outputs[*].stale` 만 본다(3-A 합류로 채웠다).
 * 기록 번호를 비교해 점을 만들면 "현재성은 stale 만 본다"는 규칙을 어긴다(DESIGN §2).
 */
export function FilesPopover({ make }: { make: Make }) {
  const { root, artifacts, projectLoad, openSheet } = useProject(useShallow((s) => ({ root: s.root, artifacts: s.artifacts, projectLoad: s.projectLoad, openSheet: s.openSheet })))
  const [open, setOpen] = useState(false)
  const { derived } = useStage()
  const files = artifacts ?? []
  /**
   * 파일마다 "지금 논문과 같은지" 한 줄 (DESIGN §2).
   * 검토본은 `outputs` 에 등록되지 않아 개정 번호로만 말하고(시안 ⑩), 나머지는
   * `outputs[*].stale` **만** 본다 — 기록 번호를 비교하지 않는다.
   */
  const statusOf = (path: string): string => {
    if (isReviewExport(path)) return derived.reviewExport !== null ? FILES_POPOVER.reviewBasis(derived.reviewExport) : FILES_POPOVER.unknown
    const state = fileStateOf(path, projectLoad)
    return state === 'same' ? FILES_POPOVER.same : state === 'stale' ? FILES_POPOVER.stale : FILES_POPOVER.unknown
  }

  return (
    <div className="pop-host">
      <button className="lnk" aria-expanded={open} title={PAPER.filesCount(files.length)} onClick={() => setOpen(!open)}>
        {/* 다시 만들어야 할 때만 호박색 점 하나(DESIGN §2) — 문구가 아니라 표시라 낭독 이름을 붙인다. */}
        {derived.stale && <span className="dot attn" title={PAPER.staleTitle} aria-label={PAPER.staleTitle} />}
        <Icon name="box" size={14} />{PAPER.filesCount(files.length)}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="right" width={400} label={PAPER.filesCount(files.length)}>
        <PopHead>{FILES_POPOVER.makeTitle}</PopHead>
        {make.rows.map((r) => (
          <div key={r.kind} className={`pop-make${r.enabled ? '' : ' off'}`}>
            <span className="c"><b>{r.label}</b><small>{r.body}</small></span>
            <button className="quiet" disabled={!r.enabled || make.making !== null} onClick={() => void make.run(r.kind)}>{FILES_POPOVER.makeAction}</button>
          </div>
        ))}
        <PopSep />
        <PopHead>{FILES_POPOVER.madeTitle}</PopHead>
        {files.length === 0
          ? <div className="pop-empty caption">{FILES_POPOVER.madeNone}</div>
          : files.map((f) => (
            /* 경로는 정본 안 상대경로다 — 플랫폼 구분자 규칙(joinPath)을 거쳐야 윈도우에서도 열린다. */
            <PopRow key={f.path} icon={<Icon name="doc" size={16} />} onClick={() => void window.knuaf.openPath(joinPath(root, f.path))} meta={statusOf(f.path)}>
              {f.name}
            </PopRow>
          ))}
        <PopSep />
        <PopRow icon={<Icon name="box" size={16} />} onClick={() => { setOpen(false); openSheet('artifacts') }}>{FILES_POPOVER.openAll}</PopRow>
        {files.length > 0 && <PopRow icon={<Icon name="folder" size={16} />} onClick={() => window.knuaf.reveal(joinPath(root, files[0].path))}>{ARTIFACTS.reveal}</PopRow>}
      </Popover>
    </div>
  )
}
