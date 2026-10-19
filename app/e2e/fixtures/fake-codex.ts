/**
 * 시험용 가짜 도우미 연결 — PATH 앞자리에 가짜 `codex app-server` 를 둔다.
 *
 * 실제 codex 가 깔린 기계와 CI 가 같은 장면을 보게 하려는 것이다(설계 §5 단계 1 픽스처).
 * 새 시험 체계가 아니다 — `codex.ts` 가 실제로 읽는 것만 맞춘 서버다.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { python, scripts, synthProject } from '../helpers'

const WIN = process.platform === 'win32'

/**
 * 가짜 CLI 를 PATH 앞자리에 둔다. 유닉스는 셔뱅 스크립트(`codex`), 윈도우는 셔뱅이 없어
 * `.cmd` 감싸개로 둔다 — `findExecutable` 은 윈도우에서 `name`·`name.cmd`·`name.exe` 순으로
 * 찾으므로 `.cmd` 도 발견된다. 자식 프로세스에 넘길 PATH 의 구분자도 플랫폼마다 다르다
 * (`:` vs `;` — 아래 `delimiter`).
 */
export function writeCliShim(dir: string, name: string, unixBody: string, winBody: string): void {
  mkdirSync(dir, { recursive: true })
  if (WIN) writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n${winBody}\r\n`, 'utf-8')
  else writeFileSync(join(dir, name), `#!/bin/sh\n${unixBody}\n`, { mode: 0o755 })
}

export const FAKE_SERVER = resolve(__dirname, 'fake-codex-server.mjs')

/** 질문 원문 — `skills/knuaf-dev/references/interview-ui.md` 의 질문 화면 형식 그대로. */
export const QUESTION_1 = `[Q3-2] Ⅲ장 판매 현황 · Ⅵ장 매출 계산에 쓰여요

지금 블루베리를 주로 어디에 팔고 있나요?

  1) 농협 공판장
  2) 온라인 직거래
  3) 로컬푸드 직매장
  4) 아직 몰라요 — 지역 판로를 찾아 제안해 드릴게요

→ 번호 또는 자유 입력`

export const QUESTION_2 = `[Q5-2] Ⅵ장 비용 계산에 쓰여요

임차료는 내년에 한 번 오르나요, 해마다 오르나요?

  1) 내년에 한 번
  2) 해마다 조금씩
  3) 아직 몰라요 — 비슷한 지역 사례를 찾아 드릴게요

→ 번호 또는 자유 입력`

/**
 * PATH 앞자리에 가짜 `codex` 를 둔 환경변수를 만든다. 셔뱅은 /bin/sh 이고 node 는
 * 절대경로로 부르므로, 시험이 좁힌 PATH 에서도 결정적으로 돈다.
 *
 * `KNUAF_AGENT_PATH_ONLY=1` 을 함께 켠다 — 이것이 없으면 `findExecutable` 이 이어서 보는
 * 사용자 설치 위치(`/opt/homebrew/bin` 등)에서 **개발 기계의 진짜 `codex`·`claude`** 가
 * 잡힌다. 그러면 "가짜만 있는 세계"를 만들려던 시험이 기계 상태에 따라 다른 장면을 본다
 * (검토 IMPL-R1-05 가 지적한 그대로 — 빈 PATH 는 도구 없음이 아니다). 가짜만 PATH 로
 * 주고 그 PATH 만 보게 한다.
 */
export function fakeCodexEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  writeCliShim(dir, 'codex',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SERVER)} "$@"`,
    `"${process.execPath}" "${FAKE_SERVER}" %*`)
  return { PATH: [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), KNUAF_AGENT_PATH_ONLY: '1', ...extra }
}

/**
 * 도우미가 기다리는 질문을 하나 넣은 논문 폴더. 카드 조건 3(`status.tasks` 에 `needs_user`)을
 * 만든다 — 한글 마무리 항목만 있으면 그건 "내가 한글에서 확인할 일"이라 카드가 아니다(GUI-10).
 */
export function questionProject(): string {
  const root = synthProject()
  const change = join(root, '.knuaf-gui-question.json')
  writeFileSync(change, JSON.stringify({
    request_id: 'e2e:task',
    ops: [{ collection: 'tasks', value: { id: 'task-interview', user_owned: true, required_fields: ['market.channel'], description: '판매처 확인' } }]
  }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', '1'], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
  return root
}

export function questionMessage(id = 'a-q1', text = QUESTION_1): Record<string, unknown> {
  return { id, role: 'assistant', text, at: new Date().toISOString() }
}

/** 대화 기록을 심는다 — 앱이 켜질 때 그대로 읽는다(`chat-codex.json`). */
export function seedChat(root: string, messages: unknown[], state = 'idle'): void {
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  writeFileSync(join(root, '.knuaf-gui', 'chat-codex.json'),
    JSON.stringify({ root, provider: 'codex', state, messages }, null, 2), 'utf-8')
}

/** 가짜 서버가 되돌려 줄 도우미 글을 파일로 둔다. */
export function replyFile(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'reply.txt')
  writeFileSync(file, text, 'utf-8')
  return file
}

/** 시험 하나가 쓸 임시 폴더 — 가짜 서버 shim·응답 파일·userData 를 한 곳에 모은다. */
export function scratch(): string {
  const dir = join(tmpdir(), `kd-qcard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 같은 PATH 자리에 가짜 `claude` 를 둔다 — 첫 화면의 "둘 다 연결됨" 장면을 만들기 위해서다.
 * 흉내 내는 것은 `claude auth status` 뿐이다(claude.ts status() 가 읽는 전부). 실제 Claude
 * 연결(SDK·작업 실행)은 여기서 띄우지 않는다.
 */
const CLAUDE_STATUS = {
  connected: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }),
  loggedOut: JSON.stringify({ loggedIn: false, authMethod: null, apiProvider: null })
}

export function writeFakeClaude(dir: string, loggedIn = true): void {
  const body = loggedIn ? CLAUDE_STATUS.connected : CLAUDE_STATUS.loggedOut
  writeCliShim(dir, 'claude',
    `printf '%s\\n' '${body}'`,
    `echo ${body}`)
}

/**
 * 로그인 상태가 **파일에 따라 바뀌는** 가짜 `claude` — `auth login` 이 그 파일을 만들고,
 * `auth status` 는 파일이 있으면 연결됨으로 답한다. 로그인 전이(로그인 전 → 폴링이 연결을
 * 알아챔)를 앱 안에서 재현하는 데 쓴다. 실제 Claude·실제 계정은 건드리지 않는다.
 */
export function writeStatefulClaude(dir: string, state: string): void {
  writeCliShim(dir, 'claude',
    `if [ "$2" = "status" ]; then if [ -f "${state}" ]; then printf '%s\\n' '${CLAUDE_STATUS.connected}'; else printf '%s\\n' '${CLAUDE_STATUS.loggedOut}'; fi; elif [ "$2" = "login" ]; then : > "${state}"; fi`,
    `if "%2"=="status" ( if exist "${state}" ( echo ${CLAUDE_STATUS.connected} ) else ( echo ${CLAUDE_STATUS.loggedOut} ) ) else if "%2"=="login" ( echo. > "${state}" )`)
}

/**
 * 설정을 미리 써 둔 userData 폴더. `helpers.launch` 는 있는 settings.json 을 **이어 쓴다**
 * (여기 적은 값은 그대로 남고, `show_intro`·`onboarded_at` 만 채워진다).
 * 허락 카드는 전역 기본(`permission_mode`)이 `trust` 면 뜨지 않는다 — 그건 설계대로다
 * (묻지 않기로 한 학생에게 카드를 다시 들이밀지 않는다). 카드 장면을 보려면 `ask` 여야 한다.
 */
export function userDataWith(dir: string, patch: Record<string, unknown> = {}): string {
  const userData = join(dir, 'userdata')
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ show_intro: false, ...patch }), 'utf-8')
  return userData
}
