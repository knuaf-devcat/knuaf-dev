import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 앱·도우미가 논문 폴더 안에 만드는 작업 폴더 — 학생의 자료가 아니다.
 * `.knuaf-gui`(대화 기록·초안), `.agents`·`.claude`(도우미 규칙집), `.venv`(이 폴더의 파이썬).
 */
export const APP_DIRS = ['.knuaf-gui', '.agents', '.claude', '.venv'] as const

/**
 * 윈도우 탐색기에서 작업 폴더를 숨긴다(형님 윈도우 실기 2026-10-19: "자기 산출물이나 자료만 나올 수
 * 있게"). 맥·리눅스는 점으로 시작하는 이름이 이미 숨김이라 아무것도 하지 않는다.
 *
 * 옮기지 않고 숨기는 이유: `.agents`·`.claude` 는 도우미가 **그 폴더에서** 규칙집을 찾는 자리이고,
 * `.venv` 는 그 폴더의 파이썬이며, `.knuaf-gui` 는 대화가 논문 폴더와 함께 다니게 하는 자리다.
 * 윈도우 기본 명령 `attrib +h` 로 숨김 속성만 붙인다(새 의존성 없음). 학생이 "숨긴 항목 보기"를
 * 켜 두었으면 흐리게 보인다 — 그건 학생의 설정이다.
 *
 * **던지지 않는다** — 숨기지 못해도 앱 흐름은 그대로다. 같은 실행에서 이미 숨긴 폴더는 다시 부르지 않는다.
 */
const done = new Set<string>()

export interface HideOptions {
  platform?: NodeJS.Platform
  /** 시험용 — 기본은 `attrib`. 성공이면 true. */
  run?: (args: string[]) => boolean
}

const attrib = (args: string[]): boolean => {
  try {
    const r = spawnSync('attrib', args, { windowsHide: true, timeout: 5000, stdio: 'ignore' })
    return r.status === 0
  } catch { return false }
}

/** `root` 아래에 있는 작업 폴더를 숨긴다. 이번에 숨긴 폴더 경로를 돌려준다. */
export function hideAppDirs(root: string, opts: HideOptions = {}): string[] {
  if ((opts.platform ?? process.platform) !== 'win32' || !root) return []
  const run = opts.run ?? attrib
  const hidden: string[] = []
  for (const name of APP_DIRS) {
    const dir = join(root, name)
    if (done.has(dir) || !existsSync(dir)) continue
    if (run(['+h', dir])) { done.add(dir); hidden.push(dir) }
  }
  return hidden
}

/** 시험용 — 이 실행에서 숨긴 기록을 지운다. */
export function forgetHidden(): void { done.clear() }
