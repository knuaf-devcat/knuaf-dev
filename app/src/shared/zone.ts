/**
 * 아래 칸 — 한 함수가 정한다.
 *
 * 화면 조각마다 조건을 흩어 놓으면 "이미 답한 질문에 카드가 다시 뜨는" 반례(v4 검토 R1-01)가
 * 생긴다. 그래서 대화 칸 맨 아래 한 자리를 무엇이 쓸지 여기서 한 번에 정한다.
 *
 * 우선순위: disconnected > permission > running > question > composer.
 */
import { parseQuestion, type ParsedQuestion } from './question'
import type { ChatSnapshot, ConnectionStatus, PermissionRequest } from './chat'
import type { Status } from './types'

export type Zone =
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'question'; card: ParsedQuestion; messageId: string }
  | { kind: 'running' }
  | { kind: 'composer' }
  /** 지금의 로그인·설치 안내 자리 — 화면은 기존 그대로다. */
  | { kind: 'disconnected' }

/**
 * 도우미가 기다리는 질문 수. `tasks`의 `needs_user`에는 한글 마무리(글꼴·여백·쪽 번호)가
 * 섞여 온다 — 그건 도우미 질문에 대한 답이 아니라 학생이 한글에서 직접 확인하는 서식
 * 일이라(GUI-10) `user_finish_pending`의 id를 뺀다.
 */
export function waitingQuestionCount(projectStatus: Status | null): number {
  const finish = new Set(projectStatus?.user_finish_pending.map((u) => u.id) ?? [])
  return projectStatus?.tasks.filter((t) => t.status === 'needs_user' && !finish.has(t.id)).length ?? 0
}

export interface QuestionCardRef { card: ParsedQuestion; messageId: string }

/**
 * 질문 카드 조건(설계 §4-1). 하나라도 확인할 수 없으면 null → 카드 없이 원문과 입력칸.
 *  1. 마지막 도우미 메시지가 질문 원문으로 해석된다.
 *  2. 그 메시지 뒤에 학생 메시지가 하나도 없다(`pending`·`uncertain`·`sent` 어느 상태든).
 *  3. 도우미가 기다리는 질문이 있다(한글 마무리 제외).
 *  4. 대화가 `idle`이다.
 */
export function questionCardOf(snapshot: ChatSnapshot | null, projectStatus: Status | null): QuestionCardRef | null {
  if (snapshot?.state !== 'idle') return null
  if (waitingQuestionCount(projectStatus) < 1) return null
  const messages = snapshot.messages
  let last = -1
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') { last = i; break }
  if (last < 0) return null
  // 답한 뒤의 학생 메시지가 하나라도 있으면 카드가 아니다(보낸 표시가 pending·uncertain이어도).
  for (let i = last + 1; i < messages.length; i++) if (messages[i].role === 'user') return null
  const card = parseQuestion(messages[last].text)
  return card ? { card, messageId: messages[last].id } : null
}

export function zoneOf(
  snapshot: ChatSnapshot | null,
  connection: ConnectionStatus | null,
  projectStatus: Status | null
): Zone {
  if (!connection?.connected) return { kind: 'disconnected' }
  if (snapshot?.permission) return { kind: 'permission', request: snapshot.permission }
  if (snapshot?.state === 'running' || snapshot?.state === 'permission') return { kind: 'running' }
  const card = questionCardOf(snapshot, projectStatus)
  if (card) return { kind: 'question', card: card.card, messageId: card.messageId }
  return { kind: 'composer' }
}
