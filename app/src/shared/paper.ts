/**
 * 종이 칸 — 방금 저장된 문단 판정 (IMPL-PLAN §4-2).
 *
 * "방금 저장된 문장만 옅은 파랑(`--new`)으로 잠깐 칠한다"(DESIGN §2). 렌더러가 절마다
 * 직전 본문을 **메모리에만** 들고 있다가 새 본문에서 새로 생긴 문단을 찾는다. 저장하지
 * 않고, 앱을 켠 직후 첫 읽기에서는 아무것도 칠하지 않는다(그때는 비교할 직전이 없다).
 *
 * 여기 있는 함수는 순수하다 — `e2e/layout.spec.ts` 가 문단 나누기와 새 문단 판정을
 * Node 단위로 고정한다.
 */

/**
 * 본문을 문단 덩어리로 나눈다. 빈 줄이 문단 경계다.
 *
 * ``` 펜스 안의 빈 줄은 경계가 아니다 — 코드 블록을 반 토막 내면 표·목록과 마찬가지로
 * 렌더가 깨진다. 문단 단위로 마크다운을 따로 렌더해야 "이 문단만 칠하기"가 되므로
 * (HTML 을 낸 뒤 다시 쪼개는 것보다 정확하다) 나누는 규칙을 여기 한 곳에 둔다.
 */
export function splitBlocks(text: string): string[] {
  const blocks: string[] = []
  let cur: string[] = []
  let fence: string | null = null
  const flush = (): void => {
    const t = cur.join('\n').trim()
    if (t) blocks.push(t)
    cur = []
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(```|~~~)/.exec(line)
    if (m) fence = fence ? null : m[1]
    if (!fence && line.trim() === '') { flush(); continue }
    cur.push(line)
  }
  flush()
  return blocks
}

/**
 * `next` 에서 **새로 생긴** 문단의 자리(0-based). 같은 글이 여러 번 있으면 개수만큼만
 * "예전 것"으로 세고 나머지는 새것으로 본다 — 도우미가 같은 문장을 한 번 더 쓴 경우에도
 * 칠해야 할 것은 새로 들어온 하나뿐이다.
 */
export function newBlockIndexes(prev: string[], next: string[]): number[] {
  const left = new Map<string, number>()
  for (const b of prev) left.set(b, (left.get(b) ?? 0) + 1)
  const out: number[] = []
  next.forEach((b, i) => {
    const n = left.get(b) ?? 0
    if (n > 0) left.set(b, n - 1)
    else out.push(i)
  })
  return out
}
