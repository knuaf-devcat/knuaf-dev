export type Provider = 'codex' | 'claude'
export type RunState = 'idle' | 'running' | 'permission' | 'interrupted' | 'error'
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
