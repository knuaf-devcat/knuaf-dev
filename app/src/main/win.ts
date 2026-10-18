/**
 * 윈도우 실행 분기 — Node 는 윈도우에서 `.cmd`/`.bat` 를 셸 없이 띄우지 못한다.
 *
 * Node ≥ 18.20.2 / 20.12 / 22 는 `spawn`/`execFile` 로 `.cmd`·`.bat` 를 직접 실행하면
 * `EINVAL` 로 거절한다(CVE-2024-27980 처방 — cmd.exe 를 거치면 인자가 이스케이프되지 않아
 * 명령 주입이 가능했기 때문). npm 으로 깐 codex·claude 가 정확히 그 `.cmd` 다.
 *
 * 그래서 **`.cmd`·`.bat` 일 때만** `cmd.exe /d /s /c` 로 감싼다. 그 밖(맥·리눅스, 그리고
 * `.exe`)은 손대지 않는다 — 넘긴 명령·인자가 그대로 간다(맥 동작 불변).
 */

export interface WinSpawn {
  command: string
  args: string[]
  /** `spawn`·`execFile` 옵션에 그대로 펼친다 — 비 Windows(또는 `.exe`)에서는 빈 객체다. */
  options: { windowsVerbatimArguments?: true; windowsHide?: true }
}

const CMD_SHIM = /\.(cmd|bat)$/i

/**
 * `cmd.exe` 한 줄에 넣을 인자 하나를 인용한다(MSVCRT 규칙): 안쪽 `"` 는 `\"` 로, 그리고
 * 닫는 `"` **앞의** 역슬래시는 두 배로 — 안 하면 그 `\` 가 닫는 `"` 를 이스케이프해 버린다.
 * 모든 인자를 인용한다 — 공백·한글 경로가 그대로 통하고, 인용 자체는 무해하다.
 */
export function cmdQuote(a: string): string {
  let out = '"'
  let backslashes = 0
  for (const ch of a) {
    if (ch === '\\') { backslashes++; continue }
    if (ch === '"') { out += '\\'.repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue }
    out += '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  return out + '\\'.repeat(backslashes * 2) + '"'
}

/**
 * 실제로 띄울 (명령, 인자, 옵션). Windows 에서 `.cmd`·`.bat` 일 때만 cmd.exe 로 감싼다.
 *
 * 인자는 **우리 코드가 만든 고정 문자열**이다 — 학생 입력과 모델 출력은 명령줄로 가지 않는다
 * (대화 본문은 JSON-RPC 로 흐른다). 여기 들어오는 것은 `auth status`·`app-server` 같은 고정
 * 인자와 경로·설정 문자열뿐이다. 그래도 cmd 로 표현할 수 없는 글자(줄바꿈·NUL)는 조용히
 * 뭉개지 않고 던진다 — 잘못 실행하느니 연결을 실패로 남긴다.
 */
export function winSpawn(command: string, args: string[], platform: NodeJS.Platform = process.platform): WinSpawn {
  if (platform !== 'win32' || !CMD_SHIM.test(command)) return { command, args, options: {} }
  for (const a of args) {
    if (/[\r\n\0]/.test(a)) throw new Error('cmd.exe 로 넘길 수 없는 인자(줄바꿈·NUL)')
  }
  const line = [command, ...args].map(cmdQuote).join(' ')
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    // `/d` 는 AutoRun 무시, `/s` 는 바깥 따옴표 한 쌍을 벗겨 나머지를 그대로 쓰라는 뜻이다 —
    // 그래서 우리가 만든 한 줄을 한 겹 더 감싼다. `windowsVerbatimArguments` 로 Node 가 이
    // 인용을 다시 손대지 못하게 막는다(그러지 않으면 안쪽 `"` 가 `\"` 로 뭉개진다).
    args: ['/d', '/s', '/c', `"${line}"`],
    // `windowsHide` — GUI 앱에서 cmd.exe 를 띄울 때 콘솔 창이 깜빡이지 않게(execFile 기본값은 false).
    options: { windowsVerbatimArguments: true, windowsHide: true }
  }
}
