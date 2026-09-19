import type { ConnectionStatus, PermissionRequest } from '../../shared/chat'
export interface AgentEvents {
  message: (id: string, text: string) => void
  permission: (request: PermissionRequest) => void
  session: (id: string) => void
  skill: () => void
}
export interface AgentConnection {
  status(): Promise<ConnectionStatus>
  login(): Promise<void>
  run(text: string, sessionId: string | undefined, events: AgentEvents): Promise<void>
  respond(id: string, allow: boolean): void
  stop(): Promise<void>
}
export interface AgentOptions {
  binary: string; root: string; skill: string; env: NodeJS.ProcessEnv
  openExternal: (url: string) => Promise<void>
}
export function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // A user's unrelated API environment must never silently change billing for this app.
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN)/.test(key)) delete env[key]
  }
  delete env.CLAUDECODE
  return env
}
