import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { PopHead, Popover, PopRow } from './Popover'
import { FilesPopover, MakeFeedbackLine, MakeRunningLine } from './FilesPopover'
import { MaterialsPopover } from './MaterialsPopover'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import { rpc } from '../rpc'
import { renderMarkdown } from '../markdown'
import { useMake } from './useMake'
import { useStage } from './useStage'
import { newBlockIndexes, splitBlocks } from '../../../shared/paper'
import { fileStateOf, isReviewExport } from '../../../shared/files'
import { zoneOf } from '../../../shared/zone'
import { hasChange } from '../../../shared/diff'
import { baselineKey, quoteOf, useReview } from '../store/review'
import { ReviewSelectBar } from './ReviewSelectBar'
import { ReviewDiffBlocks } from './ReviewDiff'
import { PAPER, REVIEW, TITLEBAR } from '../copy'
import type { SectionRow } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'

/** 절 하나의 본문. `hash` 는 정본이 말하는 본문 지문이다. */
type Doc = { title: string; draft: string; hash: string }

/**
 * 종이에서 고른 문장 — 행동 막대가 뜨는 자리와 무엇을 골랐는지.
 * 절 **제목은 담지 않는다**: 인용을 만드는 순간의 절 목록에서 읽는다(검토 MACR2-R1-01 — 제목이
 * 바뀐 뒤 옛 제목이 인용에 붙던 반례).
 */
type Sel = { text: string; sectionId: string; x: number; top: number; bottom: number }

/** 새로 저장된 문단을 칠해 두는 시간. 저장하지 않는다(IMPL-PLAN §4-2). */
const FRESH_MS = 8_000

/** 장 상태 말 — 숫자로 세지 않는다(DESIGN §2). */
function stateWord(status: string): string {
  if (status === 'empty') return PAPER.stateEmpty
  if (status === 'drafting') return PAPER.stateWriting
  return PAPER.stateDone
}

/** 표시만 구분한다 — drafting 데이터 상태와 그 밖의 매핑은 그대로 둔다. */
function visibleStateWord(status: string): string {
  return status === 'drafting' ? '초안' : stateWord(status)
}

/**
 * 질문 원문에 적힌 장(`Ⅲ장`)에 해당하는 절. 로마 숫자를 제목 앞머리에서 먼저 찾고,
 * 없으면 등록 순서로 본다 — **등록되지 않은 장은 짐작하지 않는다**(R4 원칙).
 */
function sectionForChapter(sections: SectionRow[], hint: string): SectionRow | null {
  const roman = hint.replace(/장\s*$/, '')
  const n = 'ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ'.indexOf(roman) + 1
  if (n <= 0) return null
  return sections.find((s) => s.title.trim().startsWith(roman)) ?? sections.find((s) => s.order === n) ?? null
}

/**
 * 내 논문 칸 — 저장된 논문을 종이 그대로 보여 준다 (DESIGN §2, 시안 ④~⑦⑩⑭).
 *
 * **저장된 글만** 그린다. 답을 보냈다고 문단을 미리 그리지 않고, 빈 장은 제목만 흐리게
 * 둔다 — 없는 진척을 연출하지 않는다. 방금 저장된 문단만 옅은 파랑으로 잠깐 칠한다.
 *
 * 절 목록은 `project.sections`(등록된 절 그대로)이고 Ⅰ~Ⅶ 고정이 아니다. 본문은 절마다
 * `section.read` 로 읽는다(3-A 합류 뒤 `section.read_all` 한 번으로 줄인다 — 읽는 자리는
 * `load()` 하나뿐이다).
 */
export function PaperPane({ overlay }: { overlay?: ReactNode }) {
  const { root, sections, revision, focusedSection, focusSection, setPaperClosed, setPaneView } = useProject(useShallow((s) => ({
    root: s.root, sections: s.sections, revision: s.status?.revision ?? s.peek?.revision ?? null,
    focusedSection: s.focusedSection, focusSection: s.focusSection, setPaperClosed: s.setPaperClosed, setPaneView: s.setPaneView
  })))
  const { snapshot, status } = useChat(useShallow((s) => ({ snapshot: s.snapshot, status: s.status })))
  const pStatus = useProject((s) => s.status)
  const projectLoad = useProject((s) => s.projectLoad)
  const openSheet = useProject((s) => s.openSheet)
  const make = useMake()
  const { derived, action } = useStage()
  const [docs, setDocs] = useState<Record<string, Doc>>({})
  const [fresh, setFresh] = useState<Record<string, number[]>>({})
  const [toc, setToc] = useState(false)
  /** 파일 팝오버 — 실행 결과를 어디에 그릴지 정하려고 여기서 소유한다(검토 P3-R1-01). */
  const [filesOpen, setFilesOpen] = useState(false)
  /**
   * 절마다 **직전에 본 본문**. 메모리에만 둔다 — 저장하지 않는다. 그래서 앱을 켠 직후
   * 첫 읽기에는 비교할 것이 없고, 아무것도 칠하지 않는다.
   */
  const prevDocs = useRef<Record<string, Doc>>({})
  /** 늦게 온 읽기가 그사이 바뀐 목록을 되돌리지 않게 하는 기준. */
  const sects = useRef<SectionRow[] | null>(sections)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const desk = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLElement>(null)
  sects.current = sections
  /** 종이에서 고른 문장 — 행동 막대가 뜰 자리와 무엇을 골랐는지(N-I03). */
  const [sel, setSel] = useState<Sel | null>(null)
  /**
   * 절마다 **이번 실행에서 처음 본 본문** — "고친 부분 보기"의 기준(N-I04). store 에 둔다
   * (검토 QA2B-R1-03): 여기 지역 상태였을 때 종이 칸을 닫았다 열면 컴포넌트가 새로 만들어져
   * 기준이 사라졌다. 논문(root)+절로 키를 잡아 화면 조각의 수명과 분리한다. 정본 폴더에는
   * 쓰지 않는다 — 앱을 다시 켜면 초기화된다.
   */
  const baseline = useReview((s) => s.baseline)
  const noteBaseline = useReview((s) => s.noteBaseline)
  const showDiff = useReview((s) => s.showDiff)
  const toggleDiff = useReview((s) => s.toggleDiff)
  const setQuote = useReview((s) => s.setQuote)
  const card = zoneOf(snapshot, status, pStatus)
  /** 행동 막대는 아래 칸이 **입력칸**일 때만 — 질문·허락 카드가 그 자리를 차지한다(발주 §③). */
  const canQuote = card.kind === 'composer'

  const load = useCallback(async () => {
    if (!root || !sections) { setDocs({}); return }
    // 3-A 의 `section.read_all` — 등록 순서대로 **한 번에** 읽는다(IMPL-PLAN §4-2 권장).
    // 절마다 `section.read` 를 부르던 자리이고, 읽는 곳은 여기 하나뿐이다.
    let rows: { id: string; title: string; draft: string }[]
    try {
      rows = await rpc.readAllSections(root)
    } catch {
      return   // 못 읽은 절은 이전 모습 그대로 둔다
    }
    const freshNow: Record<string, number[]> = {}
    /** 이번 읽기에서 **본문이 실제로 바뀐** 절이 있었는가 — 종이가 다시 그려진다. */
    let contentChanged = false
    for (const r of rows) {
      const sec = sections.find((s) => s.id === r.id)
      if (!sec) continue
      // 기준 본문은 **처음 본 순간에만** 박는다 — 이후 저장은 모두 이 기준과 견준다.
      const key = baselineKey(root, r.id)
      if (!useReview.getState().baseline[key]) noteBaseline(key, { title: r.title, draft: r.draft, hash: sec.draft_hash })
      const before = prevDocs.current[r.id]
      // 지문이 같으면 다시 그리지 않는다 — 같은 글이고 칠할 것도 없다.
      if (before && before.hash === sec.draft_hash) continue
      prevDocs.current[r.id] = { title: r.title, draft: r.draft, hash: sec.draft_hash }
      // 처음 보는 절이면 칠하지 않는다(앱을 켠 직후·폴더를 연 직후).
      if (before) {
        contentChanged = true
        const idx = newBlockIndexes(splitBlocks(before.draft), splitBlocks(r.draft))
        if (idx.length) freshNow[r.id] = idx
      }
    }
    if (sects.current !== sections) return
    const next: Record<string, Doc> = {}
    for (const s of sections) { const d = prevDocs.current[s.id]; if (d) next[s.id] = d }
    setDocs(next)
    // 본문이 실제로 바뀌면(저장·절 교체) 종이의 DOM 이 다시 그려진다 — 그때 담아 둔 선택은
    // 더 이상 그 글자가 아니다. 묵은 막대가 엉뚱한 자리에 뜨지 않게 지운다.
    if (contentChanged) setSel(null)
    if (Object.keys(freshNow).length) {
      setFresh(freshNow)
      timers.current.forEach(clearTimeout)
      timers.current = [setTimeout(() => setFresh({}), FRESH_MS)]
    }
  }, [root, sections, noteBaseline])

  // 폴더가 바뀌면 직전 본문을 들고 가지 않는다 — 다른 논문에 칠할 것은 없다.
  // 비교 기준(store)은 논문별 키라 건드리지 않는다 — 같은 논문을 다시 열면 이어진다.
  useEffect(() => { prevDocs.current = {}; setDocs({}); setFresh({}); setSel(null); return () => { timers.current.forEach(clearTimeout); timers.current = [] } }, [root])
  // 기록이 오르면 다시 읽는다(사이드바 차례와 같은 기준, IMPL-PLAN §4-2).
  useEffect(() => { void load() }, [load, revision])

  // 대화 이벤트 줄의 "종이에서 보기" — 그 장으로 간다.
  useEffect(() => {
    if (!focusedSection) return
    desk.current?.querySelector(`#sec-${CSS.escape(focusedSection)}`)?.scrollIntoView({ block: 'start' })
    focusSection(null)
  }, [focusedSection, focusSection])

  /**
   * 마우스를 떼면 고른 문장을 읽는다(N-I03). 선택이 **종이 안**이고 **한 장 안**일 때만 담는다 —
   * 어느 장의 문장인지 말할 수 없으면 인용 형식도 만들 수 없다.
   *
   * 아래 칸이 입력칸이 아니어도(**작업 중·질문 카드·허락 카드**) 선택을 **버리지 않는다**.
   * 막대는 그동안 숨기기만 하고(렌더의 `canQuote`), 입력칸이 돌아오면 그 선택 위에 다시 뜬다.
   * 예전에는 그 자리에서 `setSel(null)` 로 버려서 — 맥 CI 처럼 작업이 아직 도는 동안 고르면 —
   * 작업이 끝난 뒤 학생이 **처음부터 다시 골라야** 막대가 떴다(FIX-CI-MAC-R2 실패 1).
   *
   * 다만 **담아 둔 선택은 영원하지 않다.** 그 글자가 지금 화면에 그대로 골라져 있을 때만 유효하고,
   * 막대가 다시 보이는 순간과 인용·복사를 만드는 순간에 살아 있는 선택과 대조한다(아래
   * `liveSelection`·검증 effect·`quoteCurrent` — 검토 MACR2-R1-01).
   */
  const liveSelection = useCallback((): Sel | null => {
    const s = window.getSelection()
    const el = desk.current?.querySelector('.sheet')
    const host = pane.current
    if (!s || s.isCollapsed || s.rangeCount === 0 || !el || !host) return null
    const range = s.getRangeAt(0)
    if (!el.contains(range.commonAncestorContainer)) return null
    const text = s.toString().replace(/\s+/g, ' ').trim()
    if (!text) return null
    const node = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement
    const secEl = node?.closest('[id^="sec-"]') ?? null
    const section = secEl ? (sections ?? []).find((x) => `sec-${x.id}` === secEl.id) ?? null : null
    if (!section) return null
    const r = range.getBoundingClientRect()
    const pr = host.getBoundingClientRect()
    return { text, sectionId: section.id, x: r.left + r.width / 2 - pr.left, top: r.top - pr.top, bottom: r.bottom - pr.top }
  }, [sections])

  const readSelection = useCallback(() => { setSel(liveSelection()) }, [liveSelection])

  /**
   * 막대가 다시 보이는 순간(아래 칸이 입력칸일 때) 담아 둔 선택을 **살아 있는 선택과 대조**한다.
   * 비교 모드를 끄면 종이가 다시 그려져 살아 있는 선택이 사라지는데, 그때는 화면에 없는 지운
   * 문장이 막대·인용으로 남았다(반례 A). 글자나 절이 어긋나면 버린다 — 본문이 그대로인 상태
   * 전환(작업 → 입력칸)에서는 선택이 그대로 살아 있으므로 지키고, 다시 고르지 않아도 막대가 뜬다.
   *
   * 좌표는 **지금 것**으로 갱신한다(절 제목이 길어져 문단이 밀렸을 수 있다). 의존성에 좌표를 넣지
   * 않는 이유: 갱신이 다시 이 effect 를 부르면 레이아웃이 흔들릴 때 고리가 될 수 있다.
   */
  const selKey = sel ? `${sel.sectionId}\u0000${sel.text}` : ''
  useEffect(() => {
    if (!sel || !canQuote) return
    const live = liveSelection()
    if (!live || live.text !== sel.text || live.sectionId !== sel.sectionId) { setSel(null); return }
    if (live.x !== sel.x || live.top !== sel.top || live.bottom !== sel.bottom) setSel(live)
    // sel 의 좌표는 일부러 의존성에서 뺀다(위 주석) — 글자·절·구역이 바뀔 때만 다시 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canQuote, selKey, liveSelection])

  // 비교 모드를 켜고 끄면 종이가 다시 그려진다(지운/새 문장이 나타났다 사라진다) —
  // 그때 담아 둔 선택은 지금 화면의 글자가 아니다.
  useEffect(() => { setSel(null) }, [showDiff])

  /**
   * 인용을 만든다 — **반드시 살아 있는 선택**과 **지금의 절 목록**으로. 담아 둔 값을 그대로 쓰면
   * 제목이 바뀐 뒤 옛 제목이 붙는다(반례 B). 살아 있는 선택이 없으면 막대를 버린다.
   */
  const quoteCurrent = (): void => {
    const live = liveSelection()
    const section = live ? (sections ?? []).find((x) => x.id === live.sectionId) ?? null : null
    if (!live || !section || !root) { setSel(null); return }
    setQuote(quoteOf(root, live.text, section.id, section.title))
    setSel(null)
    window.getSelection()?.removeAllRanges()
  }

  /** 복사도 같은 규칙 — 살아 있는 선택의 글자를 복사한다(화면에서 사라진 글자를 복사하지 않는다). */
  const copyCurrent = (): void => {
    const live = liveSelection()
    if (!live) { setSel(null); return }
    void navigator.clipboard?.writeText(live.text)
    setSel(null)
    window.getSelection()?.removeAllRanges()
  }

  if (!root) return null
  const slotSection = card.kind === 'question' && card.card.chapterHint
    ? sectionForChapter(sections ?? [], card.card.chapterHint)?.id ?? null
    : null
  const writing = sections?.find((s) => s.status === 'drafting') ?? null
  /** 바뀐 절이 하나라도 있어야 "고친 부분 보기"가 켜진다(발주 §③). */
  const changed = (sections ?? []).some((s) => {
    const d = docs[s.id]
    const base = baseline[baselineKey(root, s.id)]
    return !!d && !!base && hasChange(base.draft, d.draft)
  })

  return (
    <section className="paperpane" aria-label={PAPER.paneLabel} ref={pane}>
      <div className="paper-head">
        <div className="pop-host">
          <button className="chap" aria-expanded={toc} onClick={() => setToc(!toc)}>
            <span className="n">{writing ? writing.title : PAPER.empty}</span>
            {writing && <span className="w">{visibleStateWord(writing.status)}</span>}
            <Icon name="chevronDown" size={14} />
          </button>
          <Popover open={toc} onClose={() => setToc(false)} label={PAPER.tocTitle} width={300}>
            <PopHead>{PAPER.tocTitle}</PopHead>
            {(sections ?? []).map((s) => (
              <PopRow key={s.id} icon={<span className="rn">{s.order}</span>} current={writing?.id === s.id}
                onClick={() => { setToc(false); desk.current?.querySelector(`#sec-${CSS.escape(s.id)}`)?.scrollIntoView({ block: 'start' }) }}
                meta={visibleStateWord(s.status)}>
                {s.title}
              </PopRow>
            ))}
          </Popover>
        </div>
        <span className="sp" />
        {snapshot?.state === 'running' && <span className="paper-live" role="status"><span className="dot" aria-hidden="true" />도우미가 작업 중</span>}
        {/* 고친 부분 보기 — 바뀐 절이 있을 때만 보인다(발주 §③ N-I04). 켜면 지운/새 문장이 색으로 갈린다. */}
        {changed && (
          <button className={`lnk review-toggle${showDiff ? ' on' : ''}`} aria-pressed={showDiff} title={REVIEW.diffToggleHint} onClick={toggleDiff}>
            <Icon name="check" size={14} />{REVIEW.diffToggle}
          </button>
        )}
        <MaterialsPopover />
        <FilesPopover make={make} open={filesOpen} onOpenChange={setFilesOpen} />
        {/* 권하는 단추 **하나** — "지금"이 고른 행동이다(1·2단계는 없다: 대화가 이끈다).
            만들기 자체는 "파일" 팝오버에서 언제든 되지만, 화면에 권하는 것은 이 하나뿐이다. */}
        {action && (
          <button className="primary" title={action.hint}
            onClick={() => {
              if (action.stage === 3) void make.run('review')
              else if (action.stage === 4) void make.run('docx')
              else openSheet('checkup')
            }}>{action.label}</button>
        )}
        {/* 좁은 창에서는 표시 여부가 `paneView` 가 정한다 — 둘 다 되돌려야 실제로 대화로 간다. */}
        <button className="lnk" onClick={() => { setPaperClosed(true); setPaneView('chat') }} title={TITLEBAR.paperClose} aria-label={TITLEBAR.paperClose}><Icon name="x" size={12} /></button>
      </div>

      {/* 팝오버를 닫아도 결과를 잃지 않는다 — 권하는 단추로 만들었거나 팝오버를 닫았으면
          종이 머리 아래 한 줄로 진행·고지·결과·실패가 보인다(검토 P3-R1-01). */}
      {!filesOpen && (make.making !== null || make.feedback) && (
        <div className="paper-fb">
          {make.making !== null
            ? <MakeRunningLine make={make} fb={make.feedback} compact />
            : make.feedback && <MakeFeedbackLine fb={make.feedback} compact submission={make.feedbackKind === 'submission_candidate'} gate={pStatus?.gate} />}
        </div>
      )}

      <div className="desk" ref={desk} onMouseUp={readSelection} onMouseDown={() => setSel(null)} onScroll={() => setSel(null)}>
        <div className="sheet">
          {(sections ?? []).length === 0
            ? <div className="paper-empty"><p className="doc-s">{PAPER.empty}</p><p className="ln">{PAPER.emptyBody}</p></div>
            : (sections ?? []).map((s) => {
              const doc = docs[s.id]
              const base = baseline[baselineKey(root, s.id)]
              const blocks = doc ? splitBlocks(doc.draft) : []
              const mark = new Set(fresh[s.id] ?? [])
              return (
                <div key={s.id} id={`sec-${s.id}`} className={blocks.length === 0 ? 'paper-empty' : undefined}>
                  <h2>{s.title}{s.status === 'drafting' && <span className="tag">초안</span>}</h2>
                  {/* "고친 부분 보기"가 켜져 있고 이 절이 실제로 바뀌었으면 비교를, 아니면 지금 본문을 그린다. */}
                  {showDiff && doc && base && hasChange(base.draft, doc.draft)
                    ? <ReviewDiffBlocks before={base.draft} after={doc.draft} />
                    : <>
                        {blocks.length === 0 && <p className="ln">{PAPER.emptyLine}</p>}
                        {/* markdown-it 이 html:false 로 만든 태그만 들어온다 — 링크·이미지는 렌더 단계에서
                            지운다(markdown.ts). 도우미가 쓴 글자가 곧 마크업이 되는 경로는 없다. */}
                        {blocks.map((b, i) => (
                          <div key={i} className={mark.has(i) ? 'blk new' : 'blk'} dangerouslySetInnerHTML={{ __html: renderMarkdown(b) }} />
                        ))}
                      </>}
                  {slotSection === s.id && <div className="slot"><Icon name="info" size={14} /><span>{PAPER.questionSlot}</span></div>}
                </div>
              )
            })}
        </div>
      </div>
      {/* 고른 문장 위에 뜨는 행동 막대(N-I03) — 좁아지면 선택 아래로 뒤집는다. */}
      {sel && canQuote && (
        <ReviewSelectBar x={sel.x} top={sel.top} bottom={sel.bottom} paneWidth={pane.current?.clientWidth ?? 0}
          onQuote={quoteCurrent} onCopy={copyCurrent} />
      )}
      {/* 점검 한 장이 논문 칸을 덮는다(시안 ⑫) — 내용은 Checkup 하나뿐이다. */}
      {overlay}
    </section>
  )
}
