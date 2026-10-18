/**
 * 시험용 가짜 도우미 연결 — PATH 앞자리에 가짜 `codex app-server` 를 둔다.
 *
 * 실제 codex 가 깔린 기계와 CI 가 같은 장면을 보게 하려는 것이다(설계 §5 단계 1 픽스처).
 * 새 시험 체계가 아니다 — `codex.ts` 가 실제로 읽는 것만 맞춘 서버다.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { python, scripts, synthProject } from '../helpers'

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
 */
export function fakeCodexEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'codex'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SERVER)} "$@"\n`,
    { mode: 0o755 })
  return { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`, ...extra }
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
 * 설정을 미리 써 둔 userData 폴더. `helpers.launch` 는 settings.json 이 이미 있으면 덮지 않는다.
 * 허락 카드는 전역 기본(`permission_mode`)이 `trust` 면 뜨지 않는다 — 그건 설계대로다
 * (묻지 않기로 한 학생에게 카드를 다시 들이밀지 않는다). 카드 장면을 보려면 `ask` 여야 한다.
 */
export function userDataWith(dir: string, patch: Record<string, unknown> = {}): string {
  const userData = join(dir, 'userdata')
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ show_intro: false, ...patch }), 'utf-8')
  return userData
}
