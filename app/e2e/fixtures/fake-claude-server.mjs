#!/usr/bin/env node
/**
 * 가짜 `claude` — 첫 화면의 로그인 전이를 앱 안에서 재현하기 위한 시험용 CLI.
 *
 * `claude.ts` 가 읽는 것은 둘뿐이다: `auth status` 의 JSON, 그리고 `auth login` 이 만드는
 * 계정 상태. 그래서 상태 파일 하나로 "로그인 전 → 로그인" 전이를 만든다.
 *
 * **왜 셸 대신 node 인가**: 이 앱은 윈도우에서 `.cmd` 를 `cmd.exe` 로 감싸 띄우고, npm shim
 * 처럼 `%*` 로 다시 파싱된다고 보고 인자를 **두 번** 이스케이프한다(`main/win.ts`). 그래서
 * `.cmd` 안에서 `%2` 를 `status` 와 문자열 비교하면 이스케이프가 남은 값과 만나 절대 참이
 * 되지 않는다 — 윈도우 CI 에서 claude 행이 "연결 상태를 확인하지 못했어요"로 떴다.
 * `fake-codex-server.mjs` 와 같이 인자를 node 로 넘겨 받으면 양쪽 OS 에서 같은 값이 온다.
 *
 * 사용: `claude auth status` · `claude auth login --claudeai`
 *   argv[2] 상태 파일 경로 — 있으면 연결됨, `auth login` 이 그 파일을 만든다.
 */
import { existsSync, writeFileSync } from 'node:fs'

/** `claude auth status` 가 연결됨으로 인정하는 응답(`ClaudeConnection.status` 의 조건과 같다). */
const CONNECTED = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })
const LOGGED_OUT = JSON.stringify({ loggedIn: false, authMethod: null, apiProvider: null })

const [state, sub, action] = process.argv.slice(2)
if (sub === 'auth' && action === 'status') {
  process.stdout.write(`${state && existsSync(state) ? CONNECTED : LOGGED_OUT}\n`)
} else if (sub === 'auth' && action === 'login') {
  if (state) writeFileSync(state, '')
}
