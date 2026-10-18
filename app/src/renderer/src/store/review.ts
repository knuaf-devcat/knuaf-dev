import { create } from 'zustand'
import { useChat } from './chat'

/**
 * 발주 QA2-B 의 검토 상태 둘 — ①종이에서 고른 문장(인용) ②고친 부분 보기 켜짐.
 *
 * 대화 칸(입력칸)은 A 워커 소유라 여기서 화면을 그리지 않는다. 대신 **상태와 메시지 규칙**을
 * 여기 한 곳에 두고, 입력칸 위 인용 칩이 이 저장소를 읽어 그린다(`ReviewQuoteChip`).
 * 그래서 인용을 꽂는 자리가 어디든(지금은 종이 칸이 임시로 띄운다) 규칙은 하나다.
 *
 * 정본 폴더에는 아무것도 쓰지 않는다 — 앱 메모리에만 산다(앱을 다시 켜면 사라진다).
 */
export type ReviewQuote = {
  /** 고른 문장 — 줄바꿈은 공백으로 눌러 한 줄로 둔다(우리가 보낼 인용 형식이 한 줄이다). */
  text: string
  /** 그 문장이 있던 장(절) id. */
  sectionId: string
  /** 그 장의 제목 — 인용 줄 `(…에서)` 에 쓴다. */
  sectionTitle: string
}

interface ReviewState {
  /** 입력칸 위에 붙어 있는 인용. 없으면 null. */
  quote: ReviewQuote | null
  setQuote: (quote: ReviewQuote) => void
  clearQuote: () => void
  /** 종이 머리 "고친 부분 보기"가 켜져 있는가. */
  showDiff: boolean
  setShowDiff: (on: boolean) => void
  toggleDiff: () => void
}

export const useReview = create<ReviewState>((set) => ({
  quote: null,
  setQuote: (quote) => set({ quote }),
  clearQuote: () => set({ quote: null }),
  showDiff: false,
  setShowDiff: (showDiff) => set({ showDiff }),
  toggleDiff: () => set((s) => ({ showDiff: !s.showDiff }))
}))

/** 고른 문장을 한 줄로 눌러 담는다 — 여러 줄 선택도 인용은 한 줄이다. */
export function quoteOf(text: string, sectionId: string, sectionTitle: string): ReviewQuote {
  return { text: text.replace(/\s+/g, ' ').trim(), sectionId, sectionTitle }
}

/**
 * 보낼 메시지 — 발주 §③ 형식 그대로.
 *
 * ```
 * > <선택 문장>
 * (<장 제목>에서)
 *
 * <학생 글>
 * ```
 * 학생 글이 비면 "이 부분을 고쳐 줘"를 대신 넣는다(무엇을 하려는지가 메시지에 남아야 한다).
 */
export function buildQuotedMessage(quote: ReviewQuote, text: string): string {
  const body = text.trim() || '이 부분을 고쳐 줘'
  return `> ${quote.text}\n(${quote.sectionTitle}에서)\n\n${body}`
}

let bridged = false
/**
 * **임시 이음매.** 입력칸(`Chat.tsx`)은 A 워커 소유라 여기서 고치지 않는다. 대신 보내는 길을
 * 한 겹 감싸, 인용이 붙어 있으면 `buildQuotedMessage` 로 합쳐 보낸다 — A 가 `Chat.tsx` 에
 * 인용 칩과 `send(buildQuotedMessage(quote, draft))` 한 줄을 꽂으면 이 함수는 지운다(REPORT).
 * 인용이 없으면 손대지 않는다(다른 시험·다른 흐름은 그대로).
 */
export function installQuoteSendBridge(): void {
  if (bridged) return
  bridged = true
  const orig = useChat.getState().send
  useChat.setState({
    send: async (text?: string) => {
      const quote = useReview.getState().quote
      if (!quote) return orig(text)
      if (text !== undefined) {   // 보기·재전송처럼 글을 지정해 보내는 길 — 합쳐서 그대로 보낸다
        const ok = await orig(buildQuotedMessage(quote, text))
        if (ok) useReview.getState().clearQuote()
        return ok
      }
      // 초안을 인용과 합쳐 보낸 뒤, 원래 `send()` 와 같은 규칙으로 초안이 비워지게 한다.
      const chat = useChat.getState()
      const prev = chat.draft
      chat.setDraft(buildQuotedMessage(quote, prev))
      const ok = await orig()
      if (ok) useReview.getState().clearQuote()
      else useChat.getState().setDraft(prev)   // 못 보냈으면 초안을 되돌린다
      return ok
    }
  })
}
