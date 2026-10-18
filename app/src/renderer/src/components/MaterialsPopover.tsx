import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Icon } from './Icon'
import { PopHead, Popover, PopRow, PopSep } from './Popover'
import { useProject } from '../store/project'
import { MATERIALS, MATERIALS_POPOVER, PAPER } from '../copy'

/** 팝오버가 보여 주는 참고자료 이름 수 — 넘으면 "외 N개"로 접는다(설계자 답 Q3). */
const REF_LIMIT = 5

/**
 * 자료 팝오버 (시안 ⑬ 머리의 "자료 N").
 *
 * **보기 전용**이다(설계자 답 Q3 ⓑ): 현재 작성물 두 줄 → 참고자료 이름 최대 5개(+"외 N개")
 * → "자료 전체 보기". 자료 넣기는 입력칸 쪽(파일 첨부)과 자료 시트가 맡는다.
 */
export function MaterialsPopover() {
  const { materials, openSheet } = useProject(useShallow((s) => ({ materials: s.materials, openSheet: s.openSheet })))
  const [open, setOpen] = useState(false)
  const files = materials?.files ?? []
  const refs = files.filter((f) => f.role === 'reference')
  const shown = refs.slice(0, REF_LIMIT)
  const more = refs.length - shown.length
  const name = (p: string | null | undefined): string | null => (p ? p.split(/[\\/]/).pop() ?? p : null)
  const current = [
    { label: MATERIALS.manuscriptLabel, value: name(materials?.current_manuscript.path), provided: !!materials?.current_manuscript.provided },
    { label: MATERIALS.financeLabel, value: name(materials?.current_finance.path), provided: !!materials?.current_finance.provided }
  ]

  return (
    <div className="pop-host">
      <button className="lnk" aria-expanded={open} title={PAPER.materialsCount(files.length)} onClick={() => setOpen(!open)}>
        <Icon name="files" size={14} />{PAPER.materialsCount(files.length)}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="right" width={340} label={MATERIALS_POPOVER.title}>
        <PopHead>{MATERIALS_POPOVER.current}</PopHead>
        {current.map((r) => (
          <PopRow key={r.label} icon={<Icon name="files" size={16} />}
            meta={r.provided ? undefined : <span className="caption">{MATERIALS_POPOVER.noneYet}</span>}>
            <span className="c"><b>{r.label}</b>{r.provided && r.value ? <small>{r.value}</small> : null}</span>
          </PopRow>
        ))}
        {refs.length > 0 && <>
          <PopSep />
          <PopHead>{MATERIALS.refTitle}</PopHead>
          {/* 이름은 한 줄 말줄임(전체 이름·경로는 title 로). 긴 목록은 안에서 스크롤해
              아래 "자료 전체 보기" 가 화면 밖으로 밀리지 않게 한다(N-I06). */}
          <div className="pop-scroll">
            {shown.map((f) => (
              <PopRow key={f.path} icon={<Icon name="doc" size={16} />}>
                <span className="c"><b title={f.path}>{name(f.path)}</b></span>
              </PopRow>
            ))}
            {more > 0 && <div className="pop-empty caption">{MATERIALS.moreFiles(more)}</div>}
          </div>
        </>}
        <PopSep />
        <PopRow icon={<Icon name="files" size={16} />} onClick={() => { setOpen(false); openSheet('materials') }}>{MATERIALS_POPOVER.all}</PopRow>
      </Popover>
    </div>
  )
}
