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
  /** `replayHistory`: resume 시 과거 턴 재생은 스냅샷에 assistant 기록이 하나도 없을 때만. */
  run(text: string, sessionId: string | undefined, events: AgentEvents, replayHistory?: boolean): Promise<void>
  respond(id: string, allow: boolean): void
  stop(): Promise<void>
}
export interface AgentOptions {
  binary: string; root: string; skill: string; env: NodeJS.ProcessEnv
  openExternal: (url: string) => Promise<void>
  /** 학생이 이 폴더를 신뢰하기로 했는가 — 판정 불가한 명령을 묻지 않고 통과시킨다. */
  trusted?: () => boolean
}
export function subscriptionEnv(extraPathDirs: string[] = []): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // A user's unrelated API environment must never silently change billing for this app.
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN)/.test(key)) delete env[key]
  }
  delete env.CLAUDECODE
  // No CLAUDE.md memory files at all — the project's skill contract (SKILL.md) is
  // authoritative, and a user's ~/.claude/CLAUDE.md @import would otherwise surface an
  // English "Allow external CLAUDE.md file imports?" security prompt to the student.
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'
  // Finder 로 띄운 앱은 셸의 PATH 를 물려받지 않는다 — /usr/bin:/bin:/usr/sbin:/sbin 뿐이다.
  // codex 는 `#!/usr/bin/env node` 스크립트라 그 PATH 로는 셔뱅이 죽고
  // "env: node: No such file or directory" 만 남는다(claude 는 네이티브라 멀쩡했다).
  // 바이너리를 찾는 것과 그 바이너리가 인터프리터를 찾는 것은 다른 문제다.
  // 프로젝트 .venv → 번들 CPython → 시스템 위치 순. 임베디드 터미널(terminal.ts)은
  // 이미 이렇게 하고 있었고, 채팅 경로만 빠져 있었다. 학생 맥의 기본 python3 는 3.9 라
  // 스킬의 최소 조건(3.10)에 못 미치는데, 이게 없으면 앱은 번들 3.12 로 잘 도는 반면
  // 도우미만 "쓸 수 있는 Python 이 없다"에 막힌다.
  env.PATH = [...extraPathDirs, ...AGENT_PATH_DIRS, env.PATH].filter(Boolean).join(':')
  return env
}

/** agentBinDirs 와 같은 자리 — 여기서 import 하면 main/agent.ts 와 순환이 된다. */
const AGENT_PATH_DIRS = process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin']
