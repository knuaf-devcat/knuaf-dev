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
/**
 * 연결 도구의 상태. `connected` 하나로는 "로그인이 필요해요"와 "확인하지 못했어요"를
 * 구별할 수 없다 — Claude 의 `auth status` 가 시간 초과·오류·잘못된 JSON 으로 실패해도
 * 예전에는 조용히 `connected:false` 가 되어 화면이 로그인을 요구했다.
 *
 * `probe` 는 그 구분이다: `'ok'` = CLI 가 정상 응답을 줬다(연결 여부는 지금 규칙대로),
 * `'failed'` = 실행 실패·시간 초과·파싱 실패라 **연결 여부를 알 수 없다**.
 * 값이 없으면 `'ok'` 로 읽는다 — 기존 호출자의 동작이 그대로다.
 */
export interface ConnectionStatus { installed: boolean; connected: boolean; version: string | null; detail: string; probe?: 'ok' | 'failed' }
export interface Artifact { path: string; name: string; kind: 'docx' | 'xlsx' | 'pdf'; modified: number }
export interface Material { path: string; role: 'manuscript' | 'finance' | 'reference'; name: string }
export type Preview = { kind: 'pdf'; url: string } | { kind: 'xlsx'; sheets: { name: string; rows: string[][]; truncated: boolean }[] } | { kind: 'unavailable'; reason: string }
export type GuiReply<T> = { result: T; error?: never } | { error: string; result?: never }
