import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Icon } from './Icon'
import { PopHead, Popover, PopRow, PopSep } from './Popover'
import { useProject } from '../store/project'
import { MATERIALS, MATERIALS_POPOVER, PAPER } from '../copy'

/**
 * 자료 팝오버 (시안 ⑬ 머리의 "자료 N").
 *
 * 요약만 보이고 전체는 오른쪽 시트로 연다(DESIGN §4-5). 여기 숫자는 `materials.list` 가
 * 준 파일 수 그대로다 — "자료가 몇 개인지"를 앱이 따로 세지 않는다.
 */
export function MaterialsPopover() {
  const { materials, openSheet } = useProject(useShallow((s) => ({ materials: s.materials, openSheet: s.openSheet })))
  const [open, setOpen] = useState(false)
  const count = materials?.files.length ?? 0
  const name = (p: string | null | undefined): string | null => (p ? p.split(/[\\/]/).pop() ?? p : null)
  const rows = [
    { label: MATERIALS.manuscriptLabel, value: name(materials?.current_manuscript.path), provided: !!materials?.current_manuscript.provided },
    { label: MATERIALS.financeLabel, value: name(materials?.current_finance.path), provided: !!materials?.current_finance.provided }
  ]

  return (
    <div className="pop-host">
      <button className="lnk" aria-expanded={open} title={PAPER.materialsCount(count)} onClick={() => setOpen(!open)}>
        <Icon name="files" size={14} />{PAPER.materialsCount(count)}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="right" width={340} label={MATERIALS_POPOVER.title}>
        <PopHead>{MATERIALS_POPOVER.current}</PopHead>
        {rows.map((r) => (
          <PopRow key={r.label} icon={<Icon name="files" size={16} />}
            meta={r.provided ? undefined : <span className="caption">{MATERIALS_POPOVER.noneYet}</span>}>
            <span className="c"><b>{r.label}</b>{r.provided && r.value ? <small>{r.value}</small> : null}</span>
          </PopRow>
        ))}
        <PopSep />
        <PopRow icon={<Icon name="files" size={16} />} onClick={() => { setOpen(false); openSheet('materials') }}>{MATERIALS_POPOVER.all}</PopRow>
      </Popover>
    </div>
  )
}
