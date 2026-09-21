import { useEffect, useState } from 'react'
import { CatMark } from './CatMark'
import { CREDIT } from '../copy'

/**
 * 들어오는 연출이 끝나고 잠깐 머문 뒤 스스로 나간다. 누르면 그 자리에서 건너뛴다.
 *
 * 스플래시는 2초 안팎이 상한이라는 것이 통설이고(Netflix 의 "N" 은 1초 미만),
 * 인위적으로 늘린 대기는 그대로 체감 지연이 된다. 그래서 화려함을 길이가 아니라
 * 밀도로 만든다 — 내용은 1.9초에 다 앉고, 읽을 틈 0.7초를 두고 나간다.
 */
const HOLD_MS = 2600
const LEAVE_MS = 360

/** 제목을 글자 단위로 흩어 놓는다 — 공백도 자리를 지켜야 줄이 흔들리지 않는다. */
function Letters({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {[...text].map((ch, i) => (
        <span key={i} className="intro-ch" style={{ '--c': i } as React.CSSProperties}>
          {ch === ' ' ? ' ' : ch}
        </span>
      ))}
    </>
  )
}

/**
 * 첫 실행에 한 번 도는 여는 화면.
 *
 * 예전에는 "내 논문" 화면 위쪽에 점선 상자로 크레딧이 조용히 얹혀 있었다. 학생이 앱을
 * 처음 열었을 때 이것이 무엇이고 누가 만들었는지 한 번은 제대로 보이게 한다.
 *
 * 연출은 전부 CSS 다 — 새 의존성 없이 `motion.css` 의 `--spring` 과 같은 결을 쓴다.
 * 움직이는 것은 transform·opacity·filter 뿐이라 레이아웃을 흔들지 않는다. 동작 줄이기를
 * 켠 학생에게는 장식 층(블룸·링·스윕)이 아예 사라지고 한 번의 페이드만 남는다.
 */
export function Intro({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    let gone = false
    const finish = () => { if (!gone) { gone = true; onDone() } }
    const leave = () => { setLeaving(true); setTimeout(finish, LEAVE_MS) }
    const hold = setTimeout(leave, HOLD_MS)
    const skip = () => { clearTimeout(hold); leave() }
    window.addEventListener('keydown', skip, { once: true })
    return () => { clearTimeout(hold); window.removeEventListener('keydown', skip); gone = true }
  }, [onDone])
  return (
    <div className="intro" data-intro="true" data-leaving={leaving || undefined} onClick={() => setLeaving(true)} role="presentation">
      <div className="intro-bloom" aria-hidden="true" />
      <div className="intro-bloom two" aria-hidden="true" />
      <div className="intro-inner">
        <div className="intro-mark">
          <span className="intro-ring" aria-hidden="true" />
          <CatMark size={160} animated label={CREDIT.markAlt} />
        </div>
        <div className="intro-title"><Letters text={CREDIT.line1} /></div>
        <div className="intro-rule" aria-hidden="true" />
        <div className="intro-line one">{CREDIT.line2}</div>
        <div className="intro-line two">{CREDIT.gui}</div>
      </div>
    </div>
  )
}
