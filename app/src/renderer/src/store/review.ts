import { create } from 'zustand'
import { REVIEW } from '../copy'

/**
 * 발주 QA2-B 의 검토 상태 — ①종이에서 고른 문장(인용) ②"고친 부분 보기" 켜짐 ③비교 기준 본문.
 *
 * 셋 다 **앱 메모리**에만 산다(정본 폴더에 쓰지 않는다 — 앱을 다시 켜면 초기화된다, REPORT 한계).
 * 다만 ③ 비교 기준은 **이 실행 동안·그 논문에 대해서는** 종이 칸을 닫았다 열어도 남아야 한다
 * (검토 QA2B-R1-03: 종이 칸 지역 상태였을 때 닫기만으로 기준이 사라졌다). 그래서 논문(root)과
 * 절로 키를 잡아 여기 store 에 둔다 — 화면 조각의 수명과 분리한다.
 */
export type ReviewQuote = {
  /** 어느 논문에서 골랐는가 — 다른 폴더 대화에 붙지 않게 한다(QA2B-R1-01). */
  root: string
  /** 고른 문장 — 줄바꿈은 공백으로 눌러 한 줄로 둔다(우리가 보낼 인용 형식이 한 줄이다). */
  text: string
  /** 그 문장이 있던 장(절) id. */
  sectionId: string
  /** 그 장의 제목 — 인용 줄 `(…에서)` 에 쓴다. */
  sectionTitle: string
}

/** 비교 기준 — 절 하나를 이번 실행에서 처음 본 본문. */
export type BaselineDoc = { title: string; draft: string; hash: string }

interface ReviewState {
  /** 입력칸 위에 붙어 있는 인용. 없으면 null. */
  quote: ReviewQuote | null
  setQuote: (quote: ReviewQuote) => void
  clearQuote: () => void
  /** 종이 머리 "고친 부분 보기"가 켜져 있는가. */
  showDiff: boolean
  setShowDiff: (on: boolean) => void
  toggleDiff: () => void
  /** `${root}::${sectionId}` → 처음 본 본문. */
  baseline: Record<string, BaselineDoc>
  /** 처음 본 순간에만 박는다 — 이후 저장은 모두 이 기준과 견준다. */
  noteBaseline: (key: string, doc: BaselineDoc) => void
}

export const useReview = create<ReviewState>((set) => ({
  quote: null,
  setQuote: (quote) => set({ quote }),
  clearQuote: () => set({ quote: null }),
  showDiff: false,
  setShowDiff: (showDiff) => set({ showDiff }),
  toggleDiff: () => set((s) => ({ showDiff: !s.showDiff })),
  baseline: {},
  noteBaseline: (key, doc) => set((s) => (s.baseline[key] ? s : { baseline: { ...s.baseline, [key]: doc } }))
}))

/** 비교 기준의 키 — 논문과 절. */
export function baselineKey(root: string, sectionId: string): string {
  return `${root}::${sectionId}`
}

/** 고른 문장을 한 줄로 눌러 담는다 — 여러 줄 선택도 인용은 한 줄이다. */
export function quoteOf(root: string, text: string, sectionId: string, sectionTitle: string): ReviewQuote {
  return { root, text: text.replace(/\s+/g, ' ').trim(), sectionId, sectionTitle }
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
  const body = text.trim() || REVIEW.quoteFallback
  return `> ${quote.text}\n(${quote.sectionTitle}에서)\n\n${body}`
}
