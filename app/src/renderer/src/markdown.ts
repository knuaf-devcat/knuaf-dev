import MarkdownIt from 'markdown-it'

/**
 * 종이 칸 마크다운 렌더 (IMPL-PLAN §4-2, DESIGN §1-1).
 *
 * 재무 표가 있어 렌더러가 필요하다. 결과는 **앱이 만든 태그만** 남는다:
 * - `html: false` — 도우미가 쓴 문자열이 그대로 마크업이 되지 않는다(원문 `<script>` 등은 글자로 남는다).
 * - `linkify: false` — 맨 주소를 링크로 만들지 않는다.
 * - 링크는 **열지 않는다**(GUI-12). `[글](주소)` 는 `글` 만 남기고 앵커를 만들지 않는다.
 * - 이미지도 그리지 않는다 — 종이 칸이 원격 주소를 부르면 "앱은 그 밖 어디에도 보내지
 *   않아요"라는 안내(PRIVACY_NOTE)가 사실이 아니게 된다. alt 글자만 남긴다.
 *
 * 어디로도 이동하지 않는 정적 글이라 이 셋을 끄는 것이 기능 손실이 아니다.
 */
const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false })

md.renderer.rules.link_open = () => ''
md.renderer.rules.link_close = () => ''
md.renderer.rules.image = (tokens, idx) => {
  const alt = tokens[idx].content
  return alt ? `${md.utils.escapeHtml(alt)} ` : ''
}

/** 마크다운 원문 → 앱이 만든 태그. 빈 원문은 빈 문자열. */
export function renderMarkdown(text: string): string {
  return text.trim() ? md.render(text) : ''
}
