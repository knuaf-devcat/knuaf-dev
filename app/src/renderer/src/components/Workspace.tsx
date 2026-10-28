import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useProject } from '../store/project'
import { hasBodyOf, useLayout } from './useLayout'
import { WIDE_MIN } from '../../../shared/layout'

/** 전이 시간(`--spring-dur`)과 같게 둔다 — 다 끝난 뒤 클래스를 내린다. */
const ENTER_MS = 500

/**
 * 작업 공간 — 대화 | 내 논문 (DESIGN §1-1, IMPL-PLAN §4-2).
 *
 * 배치는 **매번 계산**하고(useLayout), 저장하는 것은 학생이 고른 `paperClosed` 하나뿐이다.
 * 폭은 ResizeObserver 가 store 에 채운다 — 제목줄의 바꾸기가 같은 값을 봐야 하기 때문이다.
 *
 * **처음 열림**: 본문이 있는 장이 없던 상태에서 생기는 순간 종이가 옆에서 미끄러져 들어온다.
 * 폴더를 연 뒤 첫 판정에서 이미 본문이 있으면(전에 쓰던 논문) 전이 없이 곧바로 두 칸이다 —
 * 들어오는 시늉을 하면 "방금 쓴 것"처럼 보인다. `focus()` 는 부르지 않는다(DESIGN §1-1):
 * 질문 카드나 입력칸의 초점을 빼앗지 않는다.
 */
export function Workspace({ chat, paper }: { chat: ReactNode; paper: ReactNode }) {
  const layout = useLayout()
  const root = useProject((s) => s.root)
  const sections = useProject((s) => s.sections)
  const paneView = useProject((s) => s.paneView)
  const setWindowWidth = useProject((s) => s.setWindowWidth)
  const hasBody = hasBodyOf(sections)
  const [entering, setEntering] = useState(false)
  /** 직전에 본 상태(폴더 + 본문 유무). 첫 판정은 전이 없이 기준만 세운다. */
  const prev = useRef<{ root: string | null; body: boolean } | null>(null)

  useEffect(() => {
    const stage = document.querySelector('.workspace')
    if (!stage) return
    const measure = (): void => setWindowWidth(stage.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [setWindowWidth])

  useEffect(() => {
    if (prev.current?.root !== root) { prev.current = { root, body: hasBody }; setEntering(false); return }
    const opened = !prev.current.body && hasBody
    prev.current = { root, body: hasBody }
    if (!opened) return
    setEntering(true)
    const t = setTimeout(() => setEntering(false), ENTER_MS)
    return () => clearTimeout(t)
  }, [root, hasBody])

  const split = layout.kind === 'split'
  const narrow = layout.kind === 'switch'
  const showChat = !narrow || paneView === 'chat'
  const showPaper = split || (narrow && paneView === 'paper')

  return (
    <div className={`workspace${split ? ' split' : ' solo'}${entering ? ' entering' : ''}`}
      style={split ? { ['--chat-w' as string]: `${layout.chatWidth}px` } : undefined}
      data-wide={WIDE_MIN}>
      {showChat && <div className="chat-pane">{chat}</div>}
      {showPaper && paper}
    </div>
  )
}
