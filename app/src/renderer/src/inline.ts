import { createElement, Fragment, type ReactNode } from 'react'

/** `**굵게**` 한 쌍. 줄바꿈을 넘지 않는다. */
const BOLD = /\*\*([^*\n]+?)\*\*/g

/**
 * 도우미 답변의 `**굵게**` 를 굵은 글씨로 보여 준다 — 별표가 글자로 그대로 보였다(형님 윈도우 실기
 * 2026-10-19). 마크다운 전체를 그리지는 않는다: 말풍선은 원문 줄바꿈을 그대로 보이는 글이고,
 * 학생이 헷갈린 것은 별표뿐이다. 굵게 표시 안팎의 글은 `rest` 가 그린다(파일 링크 등).
 * 짝이 맞지 않는 `**` 는 글자로 둔다 — 감추지 않는다.
 * (JSX 대신 createElement — Node 단위 시험 `win-feedback.spec.ts` 가 이 파일을 그대로 부른다.)
 */
export function withBold(text: string, rest: (part: string) => ReactNode): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(BOLD)) {
    out.push(createElement(Fragment, { key: `t${last}` }, rest(text.slice(last, m.index))))
    out.push(createElement('strong', { key: `b${m.index}` }, rest(m[1])))   // 굵은 글 안의 파일 링크도 그대로(검토 WINFB-R1-02)
    last = (m.index ?? 0) + m[0].length
  }
  if (!out.length) return rest(text)
  out.push(createElement(Fragment, { key: `t${last}` }, rest(text.slice(last))))
  return out
}
