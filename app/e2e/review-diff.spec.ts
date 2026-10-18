/**
 * 발주 QA2-B 순수 함수 — 고친 부분 비교(`shared/diff`)와 보낼 인용 메시지(`store/review`).
 *
 * 화면 없이 판정할 수 있어야 한다: 문장 자르기·문단 짝짓기·인용 형식은 틀리기 쉬운 자리라
 * Node 단위로 먼저 잠근다(Playwright 가 Electron 없이 도는 시험이다 — layout.spec.ts 와 같다).
 */
import { expect, test } from '@playwright/test'
import { diffSentences, hasChange, sectionDiff, splitSentences } from '../src/shared/diff'
import { buildQuotedMessage, quoteOf } from '../src/renderer/src/store/review'

// ---------------------------------------------------------------- 문장 자르기

test('문장 자르기 — 종결부호 뒤에서만 자르고 소수는 자르지 않는다', () => {
  expect(splitSentences('가. 나! 다?')).toEqual(['가.', '나!', '다?'])
  // 소수점·줄임표 뒤에는 공백이 없으므로 문장이 갈라지지 않는다.
  expect(splitSentences('면적은 2.4톤이다')).toEqual(['면적은 2.4톤이다'])
  // 종결부호가 없으면 꼬리 전체가 한 문장이다.
  expect(splitSentences('아직 안 끝난 문장')).toEqual(['아직 안 끝난 문장'])
})

// ---------------------------------------------------------------- 문장 비교

test('문장 비교 — 600평→800평은 지움 1·새것 1, 나머지 문장은 그대로', () => {
  const before = '농장A의 재배 면적은 600평이다. 정읍 일대 기후를 고려해 작목을 선택했다.'
  const after = '농장A의 재배 면적은 800평이다. 정읍 일대 기후를 고려해 작목을 선택했다.'
  const segs = diffSentences(before, after)
  expect(segs.filter((s) => s.kind === 'del')).toEqual([{ kind: 'del', text: '농장A의 재배 면적은 600평이다.' }])
  expect(segs.filter((s) => s.kind === 'ins')).toEqual([{ kind: 'ins', text: '농장A의 재배 면적은 800평이다.' }])
  expect(segs.some((s) => s.kind === 'same' && s.text.includes('정읍'))).toBe(true)
})

test('문장 비교 — 같은 글은 전부 same 하나로 합쳐진다', () => {
  const same = '가. 나.'
  expect(diffSentences(same, same)).toEqual([{ kind: 'same', text: '가. 나.' }])
})

// ---------------------------------------------------------------- 문단 비교

test('문단이 하나 바뀌면 문장 단위로 갈라진다', () => {
  const before = '농장A의 재배 면적은 600평이다. 정읍 일대 기후를 고려해 작목을 선택했다.'
  const after = '농장A의 재배 면적은 800평이다. 정읍 일대 기후를 고려해 작목을 선택했다.'
  const blocks = sectionDiff(before, after)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].kind).toBe('segs')
})

test('문단이 통째로 늘거나 줄면 문단 단위 ins·del 로 낸다', () => {
  const added = sectionDiff('가', '가\n\n나')
  expect(added.map((b) => b.kind)).toEqual(['same', 'ins'])
  const removed = sectionDiff('가\n\n나', '가')
  expect(removed.map((b) => b.kind)).toEqual(['same', 'del'])
})

test('같은 글은 표시할 것이 없다 — hasChange 가 거짓', () => {
  expect(hasChange('가\n\n나', '가\n\n나')).toBe(false)
  expect(hasChange('가\n\n나', '가\n\n다')).toBe(true)
  expect(sectionDiff('가\n\n나', '가\n\n나').every((b) => b.kind === 'same')).toBe(true)
})

// ---------------------------------------------------------------- 보낼 메시지

const quote = quoteOf('농장A의 재배 면적은 600평이다.', 'sec-01', 'Ⅰ. 머리말')

test('인용 메시지 형식 — `> 문장` · `(장에서)` · 빈 줄 · 학생 글', () => {
  expect(buildQuotedMessage(quote, '단위를 kg으로 바꿔 줘'))
    .toBe('> 농장A의 재배 면적은 600평이다.\n(Ⅰ. 머리말에서)\n\n단위를 kg으로 바꿔 줘')
})

test('학생 글이 비면 "이 부분을 고쳐 줘"가 대신 들어간다', () => {
  expect(buildQuotedMessage(quote, '   ')).toBe('> 농장A의 재배 면적은 600평이다.\n(Ⅰ. 머리말에서)\n\n이 부분을 고쳐 줘')
})

test('여러 줄을 골라도 인용은 한 줄로 눌린다', () => {
  const multi = quoteOf('첫 줄\n둘째   줄', 'sec-01', 'Ⅰ. 머리말')
  expect(multi.text).toBe('첫 줄 둘째 줄')
})
