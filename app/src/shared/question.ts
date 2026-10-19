/**
 * 도우미 질문 원문 해석 — 질문 화면 형식은 `skills/knuaf-dev/references/interview-ui.md`가 정본이다.
 *
 *     [Q3-2] Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요
 *     지금 블루베리를 주로 어디에 팔고 있나요?
 *
 *       1) 농협 공판장
 *       2) 온라인 직거래
 *       3) 로컬푸드 직매장
 *       4) 아직 몰라요 — 지역 판로를 찾아 제안해 드릴게요
 *
 *     → 번호 또는 자유 입력
 *
 * 보수적으로 읽는다. 하나라도 어긋나면 null이다 — **틀린 카드보다 카드 없음**이 낫다.
 *
 * 다만 모양만 다른 같은 질문은 읽는다(형님 윈도우 실기 2026-10-19 — 카드가 뜨지 않음): 도우미는
 * 정본 형식을 자주 벗어난다 — 굵은 글씨(`**[Q3-2] …**`, `**1)**`), 목록·머리 표시, 보기 사이 빈 줄,
 * 윈도우 줄바꿈(CRLF), 전각 괄호. 이것들은 줄을 읽기 전에 걷어 낸다(`clean`).
 * **넓히지 않는 것**: 머리 `[Q2]`(하위 번호 없음)와 `1.` 번호. 스킬의 `[Q2] 기본 계획`처럼 그 모양은
 * "전공·작목·지역·자금을 한꺼번에 답하는" 여러 칸 질문에 쓰인다 — 하나를 고르는 카드로 만들면
 * 틀린 카드다. 보기 줄 사이에 다른 글(예시·설명 줄)이 끼어도 카드가 아니다.
 * 카드가 없으면 화면은 지금처럼 원문과 보통 입력칸을 그대로 보여 준다.
 * 값 입력형·서술형은 보기 줄이 없으니 자연히 null이다.
 */
export interface ParsedQuestion {
  /** `[Q3-2]`의 `Q3-2`. 화면 낭독 이름과 로그 역추적에 쓴다. */
  id: string
  /** 제목 줄에서 번호를 뗀 나머지 — 장 안내(예: `Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요`)나 짧은 제목. */
  use: string
  /** 질문 문장. 제목 줄과 보기 사이가 비어 있으면 제목 줄을 쓴다. */
  text: string
  /** 보기 원문(번호 접두어 없이). ` — ` 뒤 설명은 지우지 않는다 — 나눠 보여 줄 뿐이다. */
  options: string[]
  /** 원문에 적힌 장(`Ⅲ장`). 없으면 null. 종이 칸의 "이 장에 쓰여요" 한 줄에 쓴다(3단계). */
  chapterHint: string | null
  /** 대화 원문에서 접을 줄 범위(0-based, 양끝 포함). 카드가 떠 있는 동안만 접는다. */
  span: { start: number; end: number }
}

/** `[Qn-m] 제목` — 번호가 있고 제목이 비어 있지 않아야 한다. */
const TITLE = /^\s*\[Q(\d+)-(\d+)\]\s*(\S.*)$/
/** `1) 보기` — 번호와 보기 글이 있어야 한다. */
const OPTION = /^\s*(\d+)\)\s*(\S.*)$/

/**
 * 한 줄에서 모양만 다른 부분을 걷어 낸다 — 굵은·기울인 표시(`**`·`__`), 머리 표시(`### `), 목록
 * 표시(`- `·`* `·`• `), 전각 괄호, 줄 끝 `\r`. 줄 수는 바꾸지 않는다(접을 범위가 원문 줄 번호다).
 */
function clean(line: string): string {
  return line
    .replace(/\r$/, '')
    .replace(/\*\*|__/g, '')
    .replace(/[（）［］]/g, (c) => ({ '（': '(', '）': ')', '［': '[', '］': ']' })[c] ?? c)
    .replace(/^(\s*)(?:#{1,6}\s+|[-*•]\s+)/, '$1')
}
/** 장 이름(`Ⅲ장`). 로마 숫자는 학교 양식의 Ⅰ~Ⅹ까지 본다. */
const CHAPTER = /[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+장/

export function parseQuestion(text: string): ParsedQuestion | null {
  const lines = text.split('\n').map(clean)

  // ① 마지막 `[Qn-m] 제목` 줄. 한 메시지에 질문이 둘 있으면 뒤엣것이 지금 질문이다.
  let titleAt = -1
  let title: RegExpMatchArray | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = lines[i].match(TITLE)
    if (found) { titleAt = i; title = found; break }
  }
  if (titleAt < 0 || !title) return null

  // ② 제목 줄 아래 첫 `숫자) ` 줄부터 이어지는 보기 줄. 번호는 1부터 연속이어야 한다.
  let first = -1
  for (let i = titleAt + 1; i < lines.length; i++) {
    if (OPTION.test(lines[i])) { first = i; break }
  }
  if (first < 0) return null
  const options: string[] = []
  let last = first
  for (let i = first; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      // 보기 사이 빈 줄은 건너뛴다 — 다음 비지 않은 줄이 이어지는 번호의 보기일 때만.
      const next = lines.slice(i + 1).find((l) => l.trim() !== '')?.match(OPTION)
      if (next && Number(next[1]) === options.length + 1) continue
      break
    }
    const found = lines[i].match(OPTION)
    if (!found) break
    if (Number(found[1]) !== options.length + 1) return null
    options.push(found[2].trim())
    last = i
  }
  if (options.length < 2 || options.length > 5) return null

  // ③ 보기 묶음 뒤에 아직 보기 모양 줄이 남아 있으면 이 원문은 통째로 읽을 수 없다.
  // 첫 비보기 줄에서 멈춘 앞쪽 길이만 보면 `1) 2)` + 빈 줄 + `3) 4)` 같은 원문을
  // 보기 2개짜리 카드로 잘라 만든다 — 질문의 일부만 고를 수 있게 표현하는 셈이다.
  // 잘린 카드보다 카드 없음이 낫다: 원문 전체와 보통 입력칸을 그대로 보여 준다.
  // `→ …` 안내 줄과 빈 줄은 보기가 아니다(검토 P1-R1-02).
  for (let i = last + 1; i < lines.length; i++) if (OPTION.test(lines[i])) return null

  // ④ 접을 범위는 보기 줄과 바로 뒤따르는 빈 줄·`→ …` 안내 줄까지.
  let end = last
  for (let i = last + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { end = i; continue }
    if (/^\s*→/.test(lines[i])) end = i
    break
  }

  // ④ 질문 문장은 제목 줄과 보기 사이의 비어 있지 않은 줄. 없으면 제목을 쓴다.
  const between = lines.slice(titleAt + 1, first).map((l) => l.trim()).filter(Boolean)
  const use = title[3].trim()
  return {
    id: `Q${title[1]}-${title[2]}`,
    use,
    text: between.length ? between.join(' ') : use,
    options,
    chapterHint: lines.join('\n').match(CHAPTER)?.[0] ?? null,
    span: { start: first, end }
  }
}

/** ` — ` 뒤 설명을 오른쪽 작은 글로 나눈다. 없으면 두 번째 값이 null. */
export function splitOption(option: string): { main: string; note: string | null } {
  const at = option.indexOf(' — ')
  if (at < 0) return { main: option, note: null }
  return { main: option.slice(0, at), note: option.slice(at + 3) }
}

/** 고른 보기를 도우미가 받는 형식으로 되돌린다 — `2) 온라인 직거래`. */
export function optionAnswer(index: number, option: string): string {
  return `${index + 1}) ${splitOption(option).main}`
}
