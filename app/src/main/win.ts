/**
 * 윈도우 실행 분기 — Node 는 윈도우에서 `.cmd`/`.bat` 를 셸 없이 띄우지 못한다.
 *
 * Node ≥ 18.20.2 / 20.12 / 22 는 `spawn`/`execFile` 로 `.cmd`·`.bat` 를 직접 실행하면
 * `EINVAL` 로 거절한다(CVE-2024-27980 처방 — cmd.exe 를 거치면 인자가 이스케이프되지 않아
 * 명령 주입이 가능했기 때문). npm 으로 깐 codex·claude 가 정확히 그 `.cmd` 다.
 *
 * 그래서 **`.cmd`·`.bat` 일 때만** `cmd.exe /d /s /c` 로 감싼다. 그 밖(맥·리눅스, 그리고
 * `.exe`)은 손대지 않는다 — 넘긴 명령·인자가 그대로 간다(맥 동작 불변).
 *
 * ## 인용 — 두 파서를 함께 만족해야 한다
 *
 * 명령줄은 **cmd 파서**가 먼저 읽고, 그다음 대상 프로그램의 **MSVCRT argv 복원**이 읽는다.
 * 둘은 규칙이 다르다. 규칙은 cross-spawn 의 `lib/util/escape.js`(MIT)와 같다 —
 * MSVCRT 인용(`"` 앞 역슬래시는 두 배, 끝 역슬래시는 두 배) 뒤에 cmd 메타문자
 * ``()[]%!^"`<>&|;, *?`` 를 `^` 로 이스케이프한다.
 *
 * 우리가 감싸는 `.cmd`/`.bat` 는 npm shim 이라 `%*` 로 **한 번 더** 파싱되므로(cmd-shim 이
 * `node … %*` 로 넘긴다) 메타문자를 **두 번** 이스케이프한다. cross-spawn 은 그것을
 * `node_modules/.bin` 경로일 때만 하지만, 이 앱이 만나는 `.cmd` 는 전부 npm shim 이라
 * 항상 두 번으로 둔다.
 *
 * `%` 는 cmd **명령줄**에서는 확장을 막을 방법이 없다(`^%` 는 효과가 없고 `%%` 는 배치에서만
 * 통한다). 그래서 `%` 가 든 값은 **실행 전에 거절**한다 — 잘못 실행하느니 연결을 실패로 남긴다.
 * (배치 파일은 확장 단계가 달라 `%%` 로 막을 수 있다 — `agent.ts` 의 `batArg` 가 따로 처리한다.)
 */

export interface WinSpawn {
  command: string
  args: string[]
  /** `spawn`·`execFile` 옵션에 그대로 펼친다 — 비 Windows(또는 `.exe`)에서는 빈 객체다. */
  options: { windowsVerbatimArguments?: true; windowsHide?: true }
}

const CMD_SHIM = /\.(cmd|bat)$/i

/** cmd 메타문자 — cross-spawn 과 같은 집합(`%` 포함). */
const META = /([()\][%!^"`<>&|;, *?])/g

/** 실행 파일 경로 — 인용하지 않고 메타문자만 `^` 로 막는다(cross-spawn `command`). */
function escapeCommand(a: string): string {
  return a.replace(META, '^$1')
}

/** 인자 하나 — MSVCRT 인용 뒤 cmd 메타문자를 `^` 로. npm shim 이면 한 번 더. */
function escapeArgument(a: string, doubleEscape: boolean): string {
  // 아래 두 정규식은 cross-spawn 과 같은 모양(역추적 없이) — `"` 앞·끝의 역슬래시를 두 배로.
  let s = a.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  s = s.replace(/(?=(\\+?)?)\1$/, '$1$1')
  s = `"${s}"`
  s = s.replace(META, '^$1')
  if (doubleEscape) s = s.replace(META, '^$1')
  return s
}

/**
 * 실제로 띄울 (명령, 인자, 옵션). Windows 에서 `.cmd`·`.bat` 일 때만 cmd.exe 로 감싼다.
 *
 * 인자는 **우리 코드가 만든 값**이다 — 학생 입력과 모델 출력은 명령줄로 가지 않는다(대화
 * 본문은 JSON-RPC 로 흐른다). 여기 오는 것은 `auth status`·`app-server` 같은 고정 인자와
 * 경로·설정 문자열뿐이다. 그래도 cmd 로 안전하게 표현할 수 없는 값(줄바꿈·NUL·`%`)은
 * **던진다** — 잘못 실행하느니 연결을 실패로 남긴다.
 */
export function winSpawn(command: string, args: string[], platform: NodeJS.Platform = process.platform): WinSpawn {
  if (platform !== 'win32' || !CMD_SHIM.test(command)) return { command, args, options: {} }
  for (const a of [command, ...args]) {
    if (/[\r\n\0]/.test(a)) throw new Error('cmd.exe 로 넘길 수 없는 값(줄바꿈·NUL)이 있어요')
    if (a.includes('%')) throw new Error('cmd.exe 명령줄에서는 % 문자를 안전하게 넘길 수 없어요')
  }
  const line = [escapeCommand(command), ...args.map((a) => escapeArgument(a, true))].join(' ')
  return {
    command: process.env.ComSpec ?? process.env.comspec ?? 'cmd.exe',
    // `/v:off` — 지연 확장을 끈다(레지스트리 설정과 무관하게 `!` 가 글자 그대로 가게).
    // `/d` 는 AutoRun 무시, `/s` 는 바깥 따옴표 한 쌍을 벗겨 나머지를 그대로 쓰라는 뜻이다.
    // `windowsVerbatimArguments` 로 Node 가 우리 인용을 다시 손대지 못하게 막는다.
    args: ['/v:off', '/d', '/s', '/c', `"${line}"`],
    // `windowsHide` — GUI 앱에서 cmd.exe 를 띄울 때 콘솔 창이 깜빡이지 않게(execFile 기본값은 false).
    options: { windowsVerbatimArguments: true, windowsHide: true }
  }
}
