export type Provider = 'codex' | 'claude'
/**
 * 'interrupted' 는 앱이 죽은 뒤 복구했을 때, 'stopped' 는 학생이 중단을 눌렀을 때.
 * 둘을 한 상태로 쓰면 화면이 멀쩡히 살아 있는 앱을 두고 "종료됐어요"라고 말한다(GUI-05).
 */
export type RunState = 'idle' | 'running' | 'permission' | 'interrupted' | 'stopped' | 'error'
export interface ChatMessage {
  id: string; role: 'user' | 'assistant' | 'system'; text: string; at: string
  delivery?: 'pending' | 'sent' | 'uncertain'
}
export interface PermissionRequest { id: string; title: string; detail: string }
export interface ChatSnapshot {
  root: string; provider: Provider; sessionId?: string; state: RunState
  messages: ChatMessage[]; permission?: PermissionRequest; error?: string
  skillHash?: string; skillLoaded?: boolean
}
export interface ConnectionStatus { installed: boolean; connected: boolean; version: string | null; detail: string }
export interface Artifact { path: string; name: string; kind: 'docx' | 'xlsx' | 'pdf'; modified: number }
export interface Material { path: string; role: 'manuscript' | 'finance' | 'reference'; name: string }
export type Preview = { kind: 'pdf'; url: string } | { kind: 'xlsx'; sheets: { name: string; rows: string[][]; truncated: boolean }[] } | { kind: 'unavailable'; reason: string }
export type GuiReply<T> = { result: T; error?: never } | { error: string; result?: never }
