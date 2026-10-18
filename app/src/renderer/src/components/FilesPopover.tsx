import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Icon } from './Icon'
import { PopHead, Popover, PopRow, PopSep } from './Popover'
import { useProject } from '../store/project'
import { ARTIFACTS, FILES_POPOVER, PAPER } from '../copy'
import { joinPath } from '../paths'
import { useMake } from './useMake'

/**
 * 파일 팝오버 (시안 ⑩⑮) — 종이 머리의 "파일 N".
 *
 * 위: **만들기 4줄**(v2 §4-2의 입력 조건 그대로 — "지금"이 권하는 단추와 다르다).
 * 아래: 만든 파일 목록. 파일마다 "지금 논문과 같은지" 한 줄로 말한다.
 *
 * 여기서 `useMake()` 를 쓴다 — 점검 시트·결과물 전체 화면과 같은 코드다(IMPL-PLAN §4-5).
 * 파일 현재성 점(`outputs[*].stale`)은 **3-A 합류 뒤**에 붙인다: 그 값은 `project.load` 가
 * 내려 주는데 그 타입은 3-A 워커의 `rpc.ts` 에 있다. 그 전에는 점을 그리지 않는다 —
 * 기록 번호를 비교해 점을 만들면 "현재성은 stale 만 본다"는 규칙을 어긴다(DESIGN §2).
 */
export function FilesPopover() {
  const { root, artifacts, openSheet } = useProject(useShallow((s) => ({ root: s.root, artifacts: s.artifacts, openSheet: s.openSheet })))
  const [open, setOpen] = useState(false)
  const make = useMake()
  const files = artifacts ?? []

  return (
    <div className="pop-host">
      <button className="lnk" aria-expanded={open} title={PAPER.filesCount(files.length)} onClick={() => setOpen(!open)}>
        <Icon name="box" size={14} />{PAPER.filesCount(files.length)}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="right" width={400} label={PAPER.filesCount(files.length)}>
        <PopHead>{FILES_POPOVER.makeTitle}</PopHead>
        {make.rows.map((r) => (
          <div key={r.kind} className={`pop-make${r.enabled ? '' : ' off'}`}>
            <span className="c"><b>{r.label}</b><small>{r.body}</small></span>
            <button className="quiet" disabled={!r.enabled || make.making !== null} onClick={() => void make.run(r.kind)}>{r.label}</button>
          </div>
        ))}
        <PopSep />
        <PopHead>{FILES_POPOVER.madeTitle}</PopHead>
        {files.length === 0
          ? <div className="pop-empty caption">{FILES_POPOVER.madeNone}</div>
          : files.map((f) => (
            /* 경로는 정본 안 상대경로다 — 플랫폼 구분자 규칙(joinPath)을 거쳐야 윈도우에서도 열린다. */
            <PopRow key={f.path} icon={<Icon name="doc" size={16} />} onClick={() => void window.knuaf.openPath(joinPath(root, f.path))} meta={FILES_POPOVER.unknown}>
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
