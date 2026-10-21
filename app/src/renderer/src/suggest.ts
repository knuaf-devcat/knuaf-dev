import { SUGGEST } from './copy'
import type { StageDerived } from '../../shared/stage'

/**
 * 빈 입력칸에 띄울 추천 문구 — CLI 가 `Try "fix typecheck errors"` 를 보여 주는 자리다.
 *
 * 고정 목록을 시간·횟수로 돌리지 않는다(시간 회전은 눈을 끌고 스크린리더를 방해한다).
 * 대신 **지금 대화가 어떤 상황인지**를 먼저 정하고(`situationOf`), 그 상황의 문구 중에서
 * 학생이 보낸 말 수로 하나를 고른다 — 같은 상황에서는 보낼 때마다 다음 문구로 넘어간다.
 */
export type SuggestSituation =
  /** 도우미가 값(숫자·이름 등)을 물었다. */
  | 'answer-value'
  /** 도우미가 생각·이유를 물었다(그 밖의 질문). */
  | 'answer-open'
  /** 2단계, 아직 쓰는 장이 없다. */
  | 'start-writing'
  /** 2단계, 쓰는 중인 장이 있다. */
  | 'writing'
  /** 3단계 — 다 썼고 검토본이 없다. */
  | 'all-written'
  /** 4단계인데 고친 내용이 파일에 아직 없다. */
  | 'stale'
  /** 4단계(파일 없음)·5단계 — 제출 준비. */
  | 'finishing'

export interface SuggestInput {
  hasMessages: boolean
  hasQuote: boolean
  /** 아래 칸이 `running` 인가(`zone.kind === 'running'`). */
  running: boolean
  /** 대화의 마지막 메시지가 도우미 것이면 그 글, 아니면 null. */
  lastAssistant: string | null
  stage: Pick<StageDerived, 'now' | 'sections' | 'writingIndex' | 'stale'>
  /** 학생 메시지 수 — 같은 상황 안에서 문구를 돌리는 데만 쓴다. */
  userCount: number
}

/** 도우미가 "무엇을 답해 달라"고 했는지 알아보는 데 보는 줄 수 — 질문은 대개 끝에 온다. */
const TAIL_LINES = 4

/** 질문으로 읽는 말 — 물음표가 없어도 답을 청하는 문장. */
const ASKS = ['알려달라', '알려 달라', '알려줘', '알려 줘', '알려주세요', '알려 주세요', '말해 달라', '답해 달라', '적어 달라']

/** 선택형 질문의 맺음 — `QuestionCard` 가 입력칸을 차지하므로 여기 오면 자유 입력형이다. */
const CHOICE_HINTS = ['→ 번호 또는 자유 입력', '자유 입력']

/**
 * 값 하나를 받는 질문의 표시 — 예시값이나 단위가 붙는다.
 * `단위` 낱말만으로는 판정하지 않는다: "가족 단위 체험을 기획한 이유" 같은 서술형 질문이 걸린다(검토 R1-01).
 */
const VALUE_HINTS = ['(평', '㎡', '원)', '(원']

/**
 * 지금 상황 — 위에서부터 처음 맞는 것 하나다.
 * `null` 이면 예시를 띄우지 않고 기존 `답변을 입력하세요` 를 쓴다(빈 대화·인용·작업 중·1단계).
 */
export function situationOf(i: SuggestInput): SuggestSituation | null {
  if (!i.hasMessages || i.hasQuote || i.running || i.stage.now === 1) return null
  if (i.lastAssistant !== null) {
    // 마지막 빈 줄을 뺀 끝 네 줄만 본다 — 질문은 대개 답변 끝에 온다.
    const lines = i.lastAssistant.replace(/\s+$/, '').split('\n').slice(-TAIL_LINES).map((l) => l.trim())
    const asks = lines.some((l) => /[?？]$/.test(l))
      || lines.some((l) => ASKS.some((a) => l.includes(a)))
      || lines.some((l) => CHOICE_HINTS.some((h) => l.includes(h)))
    if (asks) {
      /**
       * 값 입력형 — 단위가 붙은 질문(`(평 또는 ㎡)`)이거나, `예:` 줄이 **숫자**를 보여 주는 질문
       * (`예: 600평 / 2,000㎡`). 숫자 없는 `예: 부모님의 농장을 도우며…` 는 서술형 예시다(R1-01).
       */
      const value = lines.some((l) => (/^(예|예시):/.test(l) && /[0-9]/.test(l)) || VALUE_HINTS.some((h) => l.includes(h)))
      return value ? 'answer-value' : 'answer-open'
    }
  }
  if (i.stage.now === 2) return i.stage.writingIndex >= 0 ? 'writing' : 'start-writing'
  if (i.stage.now === 3) return 'all-written'
  if (i.stage.now === 4 && i.stage.stale) return 'stale'
  return 'finishing'
}

/**
 * 지금 상황의 문구 하나. `{장}` 은 장 제목으로 바꾼다 — 쓰는 중이면 그 장, 다 썼으면 마지막 장.
 * 제목이 비면 `{장}` 이 든 문구는 건너뛰고 다음 문구를 쓴다(모두 건너뛰면 null).
 */
export function chatSuggestion(i: SuggestInput): string | null {
  const situation = situationOf(i)
  if (!situation) return null
  const list = SUGGEST[situation]
  const raw = situation === 'writing' ? i.stage.sections[i.stage.writingIndex]?.title ?? ''
    : situation === 'all-written' ? i.stage.sections.at(-1)?.title ?? ''
      : ''
  // 예시 한 줄이 입력칸 폭을 넘지 않게 — 16자를 넘으면 앞 15자 + `…`.
  const chapter = raw.length > 16 ? `${raw.slice(0, 15)}…` : raw
  for (let n = 0; n < list.length; n++) {
    const text = list[(i.userCount + n) % list.length]
    if (!text.includes('{장}')) return text
    if (chapter) return text.replaceAll('{장}', chapter)
  }
  return null
}
