/**
 * 스크롤 칸이 굴러가는 동안 `data-scrolling` 을 붙인다 — 얇은 스크롤바는 평소 투명하고 이때(와 마우스를
 * 올렸을 때)만 보인다(형님 확정 2026-10-19 스크롤바 B안, `styles/components.css` 끝).
 *
 * scroll 은 거품이 일지 않으므로 문서에서 **잡기 단계**로 한 번만 듣는다. 마지막 scroll 1초 뒤 뗀다.
 */
export const SCROLL_PANES = '.chat-thread, .desk'
export const SCROLL_LINGER_MS = 1000

export function installScrollingFlag(doc: Document = document, linger = SCROLL_LINGER_MS): () => void {
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
  const onScroll = (e: Event): void => {
    const el = e.target
    if (!(el instanceof Element) || !el.matches(SCROLL_PANES)) return
    el.setAttribute('data-scrolling', '')
    const t = timers.get(el)
    if (t) clearTimeout(t)
    timers.set(el, setTimeout(() => { el.removeAttribute('data-scrolling'); timers.delete(el) }, linger))
  }
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => doc.removeEventListener('scroll', onScroll, { capture: true })
}
