import { delimiter } from 'node:path'
import type { ChatModelInfo, ConnectionStatus, ModelChoice, PermissionRequest } from '../../shared/chat'
export interface AgentEvents {
  message: (id: string, text: string) => void
  permission: (request: PermissionRequest) => void
  /** 앱이 학생에게 직접 하는 말 — 도우미의 답변이 아니라 대화에 남는 시스템 줄. */
  note: (text: string) => void
  session: (id: string) => void
  skill: () => void
}
export interface AgentConnection {
  status(): Promise<ConnectionStatus>
  login(): Promise<void>
  /**
   * 브라우저 로그인을 그만둔다. 없으면 연결을 닫는 것으로 대신한다 — 어느 쪽이든
   * 다음 status 는 다시 물어보므로 화면 상태는 같다(로그인 필요).
   */
  cancelLogin?(): Promise<void>
  /** 진행 중인 로그인 창을 다시 연다(학생이 브라우저를 닫았을 때). */
  reopenLogin?(): Promise<void>
  /** `replayHistory`: resume 시 과거 턴 재생은 스냅샷에 assistant 기록이 하나도 없을 때만. */
  run(text: string, sessionId: string | undefined, events: AgentEvents, replayHistory?: boolean): Promise<void>
  /**
   * 이 계정이 쓸 수 있는 모델 목록. 그 통로가 아직 없는 공급자는 구현하지 않는다 —
   * ChatService 가 `supported:false` 로 답하고 화면은 추천을 띄우지 않는다(이번 판의 Claude).
   */
  models?(): Promise<ChatModelInfo[]>
  /**
   * 전송을 받아들이기 **전에** 필요한 확인(이번 판: 재개한 대화의 기본값 복귀 판정).
   * 여기서 던지면 보낸 글은 대화에 남지 않고 초안도 그대로다 — 조용히 예전 모델로 보내는
   * 대신 학생이 알 수 있는 오류로 막는다(검토 MC1-01).
   */
  prepare?(sessionId: string | undefined): Promise<void>
  respond(id: string, allow: boolean): void
  stop(): Promise<void>
}
export interface AgentOptions {
  binary: string; root: string; skill: string; env: NodeJS.ProcessEnv
  openExternal: (url: string) => Promise<void>
  /** 학생이 이 폴더를 신뢰하기로 했는가 — 판정 불가한 명령을 묻지 않고 통과시킨다. */
  trusted?: () => boolean
  /**
   * 지금 학생이 고른 모델·생각 깊이(없으면 null). **전송할 때마다** 읽는다 — 앱이 켜진 채로
   * 칩에서 바꾼 값이 다음 메시지부터 적용되어야 하고, 연결은 폴더·공급자마다 한 번만 만들어진다.
   */
  modelChoice?: () => ModelChoice | null
  /**
   * 이 공급자로 모델을 **고른 적이 있는가**. 없으면 되돌릴 덮어쓰기도 없으므로 기본값 조회
   * (ephemeral 대화)와 재개 확인을 하지 않고, 요청은 지금까지처럼 model·effort 없이 나간다.
   * 값이 없으면 `true` 로 읽는다(이 옵션을 모르는 호출자의 기존 동작 보존).
   */
  modelChosen?: () => boolean
  /** `auth status` 확인 제한 시간. 시험 이음매 — 기본 12초. */
  statusTimeoutMs?: number
}
/**
 * PATH 를 쓸 **키** 이름. 윈도우는 환경변수 이름의 대소문자를 구분하지 않고 실제 키가 `Path` 인
 * 경우가 많다 — `{...process.env}` 는 있는 그대로 복사하므로 새 `PATH` 키를 만들면 시스템 PATH 가
 * `Path` 에 남아 자식에게서 사라진다(윈도우 CI 3차). 맥·리눅스는 종전 그대로 `PATH`.
 *
 * 혼합 키(`PATH`·`Path` 공존)가 있으면 윈도우에서는 **하나로 정리한다**: Node 는 자식에게 env 키를
 * 사전순으로 정렬해 대소문자가 같은 첫 키만 전달하므로, 그 키(`PATH` < `Path`)를 남기고 나머지를
 * 지운다. 그러지 않으면 우리가 앞에 붙인 경로가 자식에게 닿지 않는다(검토 W1D-R1-02).
 *
 * **부작용(win32)**: 넘겨받은 객체에서 중복 PATH 키를 지운다. 맥·리눅스는 아무것도 지우지 않는다
 * (`PATH` 와 `Path` 는 거기서 서로 다른 변수다).
 */
export function pathKeyOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return 'PATH'
  const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH').sort()
  if (keys.length === 0) return 'PATH'
  for (const k of keys.slice(1)) delete env[k]
  return keys[0]
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
  // 구분자는 플랫폼마다 다르다(`:` vs `;`) — `:` 로 이으면 윈도우에서 `C:\…` 안의 `:` 까지
  // 갈라져 자식 프로세스의 PATH 가 통째로 뭉갠다(형님 승인 W1 연결 기제 ②).
  //
  // 윈도우는 이름의 대소문자를 구분하지 않고 실제 키가 `Path` 인 경우가 많다 — 기존 키에 잇는다
  // (새 `PATH` 키를 만들면 시스템 PATH 를 잃는다 — 위 `pathKeyOf` 주석).
  const pathKey = pathKeyOf(env)
  env[pathKey] = [...extraPathDirs, ...AGENT_PATH_DIRS, env[pathKey]].filter(Boolean).join(delimiter)
  return env
}

/** agentBinDirs 와 같은 자리 — 여기서 import 하면 main/agent.ts 와 순환이 된다. */
const AGENT_PATH_DIRS = process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin']
