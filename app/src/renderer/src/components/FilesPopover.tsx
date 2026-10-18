import { Icon } from './Icon'
import { PopHead, Popover, PopRow, PopSep } from './Popover'
import { useProject } from '../store/project'
import { ARTIFACTS, FILES_POPOVER, PAPER, fileStatusText } from '../copy'
import { joinPath } from '../paths'
import type { Make, MakeFeedback, MakeKind } from './useMake'
import { useStage } from './useStage'
import { useShallow } from 'zustand/react/shallow'

/** 만들기 피드백 한 조각 — 팝오버 안 그 줄 아래와 종이 머리 아래가 **같은 것**을 그린다. */
export function MakeFeedbackLine({ fb, compact }: { fb: MakeFeedback; compact?: boolean }) {
  return (
    <div className={`make-fb ${fb.kind}${compact ? ' compact' : ''}`} role={fb.kind === 'error' ? 'alert' : 'status'}>
      <div className="t">{fb.title}</div>
      {fb.body && <div className="b">{fb.body}</div>}
      {fb.details}
      {fb.actions && <div className="row">{fb.actions}</div>}
    </div>
  )
}

/**
 * 만드는 중 — 진행·취소 **그리고 시도 시점 고지**(검토 확인 1회째 반례 ①).
 * 고지(독립검토 미실행)는 실행이 끝난 뒤가 아니라 **누르는 순간**부터 보여야 한다.
 */
export function MakeRunningLine({ make, fb, compact }: { make: Make; fb?: MakeFeedback | null; compact?: boolean }) {
  return (
    <>
      {fb && <MakeFeedbackLine fb={fb} compact={compact} />}
      <div className={`make-fb running${compact ? ' compact' : ''}`} role="status" aria-busy="true">
        <div className="t"><span className="spin" />{FILES_POPOVER.making}</div>
        <div className="row"><button className="quiet" onClick={() => void make.runner.cancel()}>{FILES_POPOVER.cancel}</button></div>
      </div>
    </>
  )
}

/**
 * 파일 팝오버 (시안 ⑩⑮) — 종이 머리의 "파일 N".
 *
 * 위: **만들기 4줄**(v2 §4-2의 입력 조건 그대로 — "지금"이 권하는 단추와 다르다).
 * 아래: 만든 파일 목록. 파일마다 "지금 논문과 같은지" 한 줄로 말한다.
 *
 * 만들기 결과·실패·고지는 **그 줄 바로 아래**에 남는다(검토 P3-R1-01). 실행·진행·결과는
 * `useMake` 가 모듈 하나로 들고 있어, 팝오버를 닫아도 종이 머리 아래 한 줄과 "결과물 전체 보기"에서
 * 이어진다. 열림 상태는 종이 칸(`PaperPane`)이 소유한다 — 그래야 중복으로 그리지 않는다.
 */
export function FilesPopover({ make, open, onOpenChange }: { make: Make; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { root, artifacts, projectLoad, openSheet } = useProject(useShallow((s) => ({ root: s.root, artifacts: s.artifacts, projectLoad: s.projectLoad, openSheet: s.openSheet })))
  const { derived } = useStage()
  const files = artifacts ?? []
  /** 파일마다 한 줄 — 판정은 copy.ts 의 `fileStatusText` 한 곳에 있다(점검 시트도 같은 것을 쓴다). */
  const statusOf = (path: string): string => fileStatusText(path, projectLoad)
  const feedbackFor = (kind: MakeKind): MakeFeedback | null => (make.feedbackKind === kind ? make.feedback : null)

  return (
    <div className="pop-host">
      <button className="lnk" aria-expanded={open} title={PAPER.filesCount(files.length)} onClick={() => onOpenChange(!open)}>
        {/* 다시 만들어야 할 때만 호박색 점 하나(DESIGN §2) — 문구가 아니라 표시라 낭독 이름을 붙인다. */}
        {derived.stale && <span className="dot attn" title={PAPER.staleTitle} aria-label={PAPER.staleTitle} />}
        <Icon name="box" size={14} />{PAPER.filesCount(files.length)}
      </button>
      <Popover open={open} onClose={() => onOpenChange(false)} align="right" width={400} label={PAPER.filesCount(files.length)}>
        <PopHead>{FILES_POPOVER.makeTitle}</PopHead>
        {make.rows.map((r) => (
          /* 한 줄 + 그 줄의 피드백을 한 묶음으로 — 시험은 `[data-make="<종류>"] .make-fb` 로 집는다. */
          <div key={r.kind} className="pop-make-block" data-make={r.kind}>
            <div className={`pop-make${r.enabled ? '' : ' off'}`}>
              <span className="c"><b>{r.label}</b><small>{r.body}</small></span>
              <button className="quiet" disabled={!r.enabled || make.making !== null} onClick={() => void make.run(r.kind)}>{FILES_POPOVER.makeAction}</button>
            </div>
            {/* 그 줄에서 시작한 실행의 고지·진행·결과·실패 — 시도 전에도 고지가 먼저 뜬다. */}
            {make.making === r.kind && <MakeRunningLine make={make} fb={feedbackFor(r.kind)} compact />}
            {make.making !== r.kind && feedbackFor(r.kind) && <MakeFeedbackLine fb={feedbackFor(r.kind)!} compact />}
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
        <PopRow icon={<Icon name="box" size={16} />} onClick={() => { onOpenChange(false); openSheet('artifacts') }}>{FILES_POPOVER.openAll}</PopRow>
        {files.length > 0 && <PopRow icon={<Icon name="folder" size={16} />} onClick={() => window.knuaf.reveal(joinPath(root, files[0].path))}>{ARTIFACTS.reveal}</PopRow>}
      </Popover>
    </div>
  )
}
