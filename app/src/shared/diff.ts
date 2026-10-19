/**
 * 종이 칸 "고친 부분 보기"(발주 QA2-B · N-I04) — 문장 단위 비교.
 *
 * 순수 함수만 둔다. 절 본문(마크다운) 두 판을 받아, 같은 문단은 그대로 두고 **바뀐 문단만**
 * 문장 단위로 갈라 지운 것/새것을 낸다. 화면은 이 결과를 색으로 칠하기만 한다.
 *
 * 색 규칙(발주 §③): 지운 문장은 빨강 취소선, 새/바뀐 문장은 초록 바탕. 왼쪽 색선은 쓰지 않는다.
 * 문단을 통째로 새로 쓰거나 지운 경우(표·목록이 섞일 수 있다)는 문단 단위로 내고, 화면은 그
 * 문단을 마크다운 그대로 그린 뒤 `del`/`ins` 상자로 감싼다(마크다운 렌더 경로를 깨지 않는다).
 *
 * 비교 대상은 **앱이 들고 있는 기준 본문**뿐이다 — 정본 폴더에 기준을 쓰지 않는다. 그래서
 * 앱을 다시 켜면 기준이 초기화된다(REPORT 의 한계).
 */
import { splitBlocks } from './paper'

export type DiffSeg = { kind: 'same' | 'del' | 'ins'; text: string }

export type BlockDiff =
  | { kind: 'same'; markdown: string }
  | { kind: 'ins'; markdown: string }
  | { kind: 'del'; markdown: string }
  | { kind: 'segs'; segs: DiffSeg[] }

/**
 * 문장 경계로 나눈다 — `.` `?` `!` `。` 뒤에 공백/줄바꿈/끝이 올 때만 자른다.
 * 그래서 소수(2.4)와 줄임표(…)는 자르지 않고, 종결부호는 앞 문장에 붙여 남긴다.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  let buf = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    buf += ch
    if (ch === '.' || ch === '?' || ch === '!' || ch === '。') {
      const next = text[i + 1]
      if (next === undefined || /\s/.test(next)) { if (buf.trim()) out.push(buf.trim()); buf = '' }
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

/** 문장 LCS — 순서를 지키며 같은/지운/새 문장을 낸다. 이어진 같은 종류는 하나로 합친다. */
export function diffSentences(before: string, after: string): DiffSeg[] {
  const a = splitSentences(before)
  const b = splitSentences(after)
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffSeg[] = []
  const push = (kind: DiffSeg['kind'], text: string): void => {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text = `${last.text} ${text}`
    else out.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++ }
    else { push('ins', b[j]); j++ }
  }
  while (i < n) push('del', a[i++])
  while (j < m) push('ins', b[j++])
  return out.length ? out : [{ kind: 'same', text: '' }]
}

/** 같은 문단의 자리(인덱스) 쌍을 순서대로 — 문단 LCS. */
function blockMatches(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}

/**
 * **구조 블록**인가 — 표·목록·제목·인용처럼 문장 단위로 갈라 평문으로 그리면 무너지는 블록.
 * 이런 블록은 문장 비교 대신 **블록 통째 del/ins** 로 내고, 화면이 마크다운 그대로 그린다
 * (검토 QA2B-R1-04: 바뀐 표가 `| … |` 원문 한 덩어리로 붕괴했다).
 */
export function isStructural(block: string): boolean {
  return block.split('\n').some((line) => /^\s*(\||>|#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(line))
}

/**
 * 절 하나의 비교 — 문단 경계(`splitBlocks`)를 지키며 낸다.
 * 같지 않은 구간에 문단이 하나씩 짝지어지고 **둘 다 구조 블록이 아니면** 문장 단위로 갈라 내고,
 * 그 밖에는 문단 통째로 낸다(구조는 마크다운 렌더를 유지한다).
 */
export function sectionDiff(before: string, after: string): BlockDiff[] {
  const a = splitBlocks(before)
  const b = splitBlocks(after)
  const out: BlockDiff[] = []
  let ai = 0
  let bi = 0
  const flush = (aEnd: number, bEnd: number): void => {
    const del = a.slice(ai, aEnd)
    const ins = b.slice(bi, bEnd)
    if (!del.length && !ins.length) return
    if (del.length === 1 && ins.length === 1 && !isStructural(del[0]) && !isStructural(ins[0])) {
      out.push({ kind: 'segs', segs: diffSentences(del[0], ins[0]) })
    } else {
      for (const t of del) out.push({ kind: 'del', markdown: t })
      for (const t of ins) out.push({ kind: 'ins', markdown: t })
    }
  }
  for (const [x, y] of blockMatches(a, b)) {
    flush(x, y)
    out.push({ kind: 'same', markdown: b[y] })
    ai = x + 1
    bi = y + 1
  }
  flush(a.length, b.length)
  return out
}

/** 바뀐 것이 하나라도 있는가 — 종이 머리 토글을 켤 수 있는지 판정한다. */
export function hasChange(before: string, after: string): boolean {
  return splitBlocks(before).join('\u0000') !== splitBlocks(after).join('\u0000')
}
