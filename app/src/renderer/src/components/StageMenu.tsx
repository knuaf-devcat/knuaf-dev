import { useState } from 'react'
import { Icon } from './Icon'
import { PopHead, Popover, PopRow } from './Popover'
import { useProject } from '../store/project'
import { useStage } from './useStage'
import { STAGES, TITLEBAR } from '../copy'

/**
 * 제목줄 가운데 "지금 · 인터뷰·장 쓰기 ▾" (DESIGN §2, 시안 ⑬).
 *
 * **"지금"은 한 곳뿐이다**: 닫혀 있을 때는 이 단추가, 열려 있으면 목록의 한 줄이 말한다
 * (검토 R1-02). 열려 있는 동안 단추 글자는 "전체 과정"으로 바뀐다.
 *
 * 단계마다 사실 한 줄은 `useStage()`(3-A 의 `derive`)가 준 것만 쓴다 — 없는 개수를 짓지
 * 않는다. 5단계 줄은 **점검으로 들어가는 정식 진입점**이다(설계자 답 Q6) — 그래서 누를 수 있다.
 * 2단계는 권하는 행동이 없으므로(대화가 이끈다) 줄만 보여 준다.
 */
export function StageMenu() {
  const [open, setOpen] = useState(false)
  const openSheet = useProject((s) => s.openSheet)
  const status = useProject((s) => s.status)
  const { inputs, derived } = useStage()
  const now = derived.now
  const finish = status?.user_finish_pending.length ?? 0

  const facts: string[] = [
    STAGES.fact.ready(inputs.connected, inputs.hasProject),
    STAGES.fact.write(derived.questions, derived.sectionsAllReady),
    STAGES.fact.review(derived.reviewExport),
    STAGES.fact.output(derived.stale, derived.hasDocx),
    STAGES.fact.finish(finish)
  ]

  return (
    <div className="pop-host">
      <button className="tbtn now" aria-expanded={open} title={open ? TITLEBAR.nowClose : TITLEBAR.nowOpen}
        onClick={() => setOpen(!open)}>
        {open ? TITLEBAR.nowTitle : <><span className="lbl">{TITLEBAR.nowLabel}</span>{STAGES.names[now - 1]}</>}
        <Icon name="chevron" size={14} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="center" width={400} label={TITLEBAR.nowTitle}>
        <PopHead>{STAGES.head}</PopHead>
        {STAGES.names.map((name, i) => {
          const n = i + 1
          return (
            <PopRow key={name} icon={<span className="rn">{n}</span>} current={n === now}
              onClick={n === 5 ? () => { setOpen(false); openSheet('checkup') } : undefined}
              meta={n === now ? <span className="now-w">{TITLEBAR.nowLabel}</span> : undefined}>
              <span className="c"><b>{name}</b><small>{facts[i]}</small></span>
            </PopRow>
          )
        })}
      </Popover>
    </div>
  )
}
