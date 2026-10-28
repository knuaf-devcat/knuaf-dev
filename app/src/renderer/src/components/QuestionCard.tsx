import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CHAT } from '../copy'
import { optionAnswer, splitOption, type ParsedQuestion } from '../../../shared/question'

/**
 * 보기 연필 아이콘 — 아이콘 집합(Icon.tsx)은 이 단계 파일 경계 밖이라 여기에 둔다.
 * 장식 기호(✎)를 쓰지 않고 선 아이콘만 쓴다(DESIGN §4).
 */
function Pen() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20l4-1 10-10a2.1 2.1 0 0 0-3-3L5 16l-1 4z" />
      <path d="M14.5 5.5l4 4" />
    </svg>
  )
}

interface Props {
  card: ParsedQuestion
  /** 직접 입력 칸의 값은 보통 입력칸과 **같은 초안 하나**다(설계 §3-1) — 오가도 글이 남는다. */
  draft: string
  onDraft: (text: string) => void
  /** 보기를 보내거나(`text`), 직접 입력을 보낸다(초안). 거절되면 false — 잠금을 푼다. */
  onSend: (text?: string) => Promise<boolean>
}

/**
 * 도우미 질문 카드 — 입력칸 자리를 **대신 차지한다**(둘이 같이 있으면 "쳐야 해? 눌러야 해?"가
 * 생긴다). 보기를 누르거나 숫자 키를 누르면 바로 보내고, 마지막 줄 "직접 입력"은 내 말로
 * 답하는 자리다.
 */
export function QuestionCard({ card, draft, onDraft, onSend }: Props) {
  const [mode, setMode] = useState<'pick' | 'free'>('pick')
  const [chosen, setChosen] = useState<number | null>(null)
  /**
   * 잠금은 렌더 뒤가 아니라 **고른 순간 동기적으로** 건다. 빠르게 1·2를 눌러도 학생
   * 메시지는 하나여야 한다(검토 R1-04). 실패하면 풀고, 오류는 기존 오류 표시가 말한다.
   */
  const locked = useRef(false)
  const box = useRef<HTMLDivElement>(null)
  const free = useRef<HTMLTextAreaElement>(null)

  // 카드가 처음 나타나면 카드 컨테이너에 초점을 준다 — 입력칸이 사라지는 순간 초점이
  // body 로 떨어지는 것을 막는다. 단 학생이 다른 곳에 글을 쓰는 중이면 빼앗지 않는다.
  useEffect(() => {
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
    box.current?.focus()
  }, [])

  const send = async (text?: string): Promise<void> => {
    if (locked.current) return
    locked.current = true
    const ok = await onSend(text)
    if (!ok) locked.current = false
  }

  const pick = (index: number): void => {
    if (locked.current) return
    setChosen(index)
    void send(optionAnswer(index, card.options[index]))
  }

  const openFree = (): void => {
    if (locked.current) return
    setMode('free')
    // 펼치는 순간 바로 쓸 수 있게. 초안은 그대로 이어진다.
    requestAnimationFrame(() => free.current?.focus())
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      // 직접 입력에서 되돌아가기. 초안은 건드리지 않는다.
      if (mode === 'free') { e.preventDefault(); setMode('pick'); box.current?.focus() }
      return
    }
    const active = document.activeElement
    // 숫자 키는 글 쓰는 칸에 초점이 없을 때만, 수정자 없이.
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const n = Number(e.key)
    if (Number.isInteger(n) && n >= 1 && n <= card.options.length) { e.preventDefault(); pick(n - 1) }
  }

  return (
    <div className="qcard" role="group" aria-label={CHAT.questionGroup(card.id)} tabIndex={-1} ref={box} onKeyDown={onKeyDown}>
      <p className="sr-only" aria-live="polite">{CHAT.questionArrived}</p>
      <div className="qcard-use">{card.use}</div>
      <div className="qcard-q">{card.text}</div>
      {/* 보기 1~n은 직접 입력 중에도 그대로 남는다(시안 E). 마지막 줄만 입력 영역으로 펼쳐진다 —
          보기가 사라지면 마음이 바뀌었을 때 되돌아갈 곳이 없어진다(검토 P1-R1-04). */}
      <div className="qcard-opts" role="radiogroup" aria-label={CHAT.questionOptions}>
        {card.options.map((option, i) => {
          const { main, note } = splitOption(option)
          return (
            <button key={i} type="button" role="radio" aria-checked={chosen === i}
              className={`qopt${chosen === i ? ' on' : ''}`} onClick={() => pick(i)}>
              <span className="qopt-k">{i + 1}</span>
              <span className="qopt-body">
                <span className="qopt-t">{main}</span>
                {note && <span className="qopt-x">{note}</span>}
              </span>
            </button>
          )
        })}
        {mode === 'pick' ? (
          <button type="button" className="qopt free" onClick={openFree}>
            <span className="qopt-k"><Pen /></span>
            <span className="qopt-t">{CHAT.directInput}</span>
          </button>
        ) : (
          <div className="freebox">
            <textarea ref={free} value={draft} rows={2} placeholder={CHAT.freePlaceholder}
              onChange={(e) => onDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (draft.trim()) void send() } }} />
            <button type="button" className="send" onClick={() => { if (draft.trim()) void send() }} disabled={!draft.trim()}>{CHAT.send}</button>
          </div>
        )}
      </div>
      <div className="qcard-foot">
        {mode === 'pick'
          ? <><kbd>1</kbd><span>–</span><kbd>{card.options.length}</kbd><span>{CHAT.optionKeysTail}</span></>
          : <>
            <button type="button" className="qhint" onClick={() => { setMode('pick'); box.current?.focus() }}>{CHAT.backToOptions}</button>
            <span className="sp" />
            <kbd>Esc</kbd><span>{CHAT.freeHintBack}</span><span>·</span><kbd>Enter</kbd><span>{CHAT.send}</span>
          </>}
      </div>
    </div>
  )
}
