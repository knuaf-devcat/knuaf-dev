import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * 학생 논문 폴더에 파일을 남기는 **공용 쓰기** (WIN-ONEDRIVE).
 *
 * 왜 필요한가: 윈도우에서 논문 폴더가 OneDrive 동기화 폴더(예: `OneDrive\바탕 화면\…`)이면,
 * 동기화 클라이언트·백신·검색 색인이 그 순간 파일을 쥐고 있어 `renameSync` 가
 * `EPERM: operation not permitted` 로 실패한다. 그 예외가 **main 프로세스의 이벤트 콜백**에서
 * 올라오면 Electron 이 "A JavaScript error occurred in the main process" 오류 창을 띄운다 —
 * 형님 윈도우 노트북에서 실제로 그랬다(`ChatService.publish`).
 *
 * 규칙: ① 임시 파일(`.tmp`)에 쓰고 ② 이름 바꾸기로 대상과 교체한다. 다시 시도해 볼 만한 오류면
 * 짧게 재시도하고(main 스레드를 오래 막지 않게 합계 수백 ms 이하), 그래도 안 되면 **던지지 않고**
 * 실패를 돌려준다. 이름 바꾸기가 막혔으면 완성본은 `.tmp` 에 남는다 — 읽는 쪽(`readRecoverable`)이
 * 온전한 `.tmp` 를 먼저 읽는다.
 *
 * 보존 규칙(WIN-ONEDRIVE-R1-01): **대상은 이름 바꾸기로만 바뀐다 — 직접 덮어쓰지 않는다.**
 * 그래서 대상은 언제나 어느 시점의 완성본이다. 직접 쓰기 폴백은 대상을 먼저 비우므로 중간에 멈추면
 * 기존 대화를 반쪽으로 만들고, 그 뒤 하나 남은 `.tmp` 마저 다음 저장이 다시 쓰다 멈추면 완성본이
 * 하나도 남지 않았다(1회째 판정·확인 반례). 폴백을 없애면 `.tmp` 쓰기가 어디서 멈추든 대상은 남는다.
 */

/** 잠깐 막힌 것일 뿐일 수 있는 오류 — 다시 시도해 볼 만하다. */
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** 재시도 사이의 대기(ms). 합계 300ms — main 스레드를 오래 붙잡지 않는다. */
export const RETRY_DELAYS_MS = [20, 40, 80, 160]

export interface SafeWriteFs {
  writeFileSync: typeof writeFileSync
  renameSync: typeof renameSync
  unlinkSync: typeof unlinkSync
}

export interface SafeWriteOptions {
  /** 파일 권한(대화 기록·초안은 0o600). */
  mode?: number
  /** 재시도 대기열 — 시험에서 0 으로 줄인다. */
  delaysMs?: number[]
  /** 시험용 대역(파일시스템) — 기본은 node:fs. */
  fs?: SafeWriteFs
  /** 남길 곳 — 기본은 console.error(main 에는 다른 로그 자리가 없다). */
  log?: (message: string) => void
}

export type WriteResult = { ok: true } | { ok: false; error: Error }

const codeOf = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? ''
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

/** main 스레드를 막고 기다린다 — 의존성을 더하지 않으려고 Atomics 로 잔다. */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const defaultLog = (message: string): void => { console.error(message) }

/**
 * 파일 하나를 되도록 원자적으로 남긴다. **던지지 않는다** — 결과를 돌려준다.
 *
 * 실패해도 호출부의 화면 흐름은 멈추지 않는다: 메모리의 상태는 이미 최신이고, 저장은
 * 나중에 다시 시도될 수 있다(`publish` 는 다음 이벤트에서 다시 쓴다).
 */
export function writeFileAtomic(file: string, data: string, opts: SafeWriteOptions = {}): WriteResult {
  const fs: SafeWriteFs = opts.fs ?? { writeFileSync, renameSync, unlinkSync }
  const delays = opts.delaysMs ?? RETRY_DELAYS_MS
  const log = opts.log ?? defaultLog
  const tmp = tmpOf(file)

  // 재시도 대기는 쓰기·이름 바꾸기가 함께 쓴다 — 합계가 RETRY_DELAYS_MS 를 넘지 않는다.
  let attempt = 0
  const retry = (e: unknown): boolean => {
    if (!RETRY_CODES.has(codeOf(e)) || attempt >= delays.length) return false
    sleepSync(delays[attempt++])
    return true
  }
  const fail = (e: unknown, note: string): WriteResult => {
    const error = asError(e)
    log(`[knuaf] 파일을 저장하지 못했어요: ${file} (${codeOf(error) || error.message}) — ${note}`)
    return { ok: false, error }
  }

  // ① 완성본을 `.tmp` 에 만든다. 중간에 멈춰도 대상은 그대로다.
  for (;;) {
    try { fs.writeFileSync(tmp, data, { encoding: 'utf8', ...(opts.mode === undefined ? {} : { mode: opts.mode }) }); break } catch (e) {
      if (!retry(e)) return fail(e, '기존 파일은 그대로 두었어요')
    }
  }
  // ② 이름 바꾸기로 교체한다. 막히면 완성본은 `.tmp` 에 남는다(동기화 클라이언트가 대상을 쥔 경우).
  for (;;) {
    try { fs.renameSync(tmp, file); return { ok: true } } catch (e) {
      if (!retry(e)) return fail(e, `최신 내용은 ${tmp} 에 남겼어요`)
    }
  }
}

/** `writeFileAtomic` 이 쓰는 임시 파일 자리. */
export const tmpOf = (file: string): string => `${file}.tmp`

export interface ReadFs {
  readFileSync: (path: string, encoding: 'utf8') => string
}

/**
 * `writeFileAtomic` 이 남긴 파일을 읽는다 — 온전한 `.tmp` 가 있으면 그것을, 없으면 대상을 읽는다.
 *
 * `parse` 는 내용을 검증해 값을 돌려주거나 던진다. `.tmp` 는 마지막 쓰기의 이름 바꾸기가 막혔을 때만
 * 남고(성공한 쓰기는 자기 `.tmp` 를 대상으로 옮긴다), 그때 `.tmp` 가 가장 최신이다. 대상은 이름
 * 바꾸기로만 바뀌므로 언제나 어느 시점의 완성본이다.
 * 남는 한계: `.tmp` 를 쓰다 멈춘 반쪽(디스크 가득·앱 강제 종료)은 `parse` 가 거르지 못하면 그대로
 * 읽힌다 — JSON 대화 기록은 거르고(대상을 읽는다), 초안 글은 거르지 못한다(반쪽 초안이 보인다).
 *
 * 돌려주는 값: 없음(`null`), 또는 `{ value, from }`. 대상이 망가졌고 `.tmp` 로도 못 살리면
 * 대상의 오류를 **던진다** — 빈 기록으로 덮어 원본을 잃지 않게(호출부가 오류로 보여 준다).
 */
export function readRecoverable<T>(file: string, parse: (text: string) => T, fs: ReadFs = { readFileSync }): { value: T; from: 'file' | 'tmp' } | null {
  type Got = { ok: true; value: T } | { ok: false; missing: boolean; error: unknown }
  const get = (path: string): Got => {
    let text: string
    try { text = fs.readFileSync(path, 'utf8') } catch (e) { return { ok: false, missing: codeOf(e) === 'ENOENT', error: e } }
    try { return { ok: true, value: parse(text) } } catch (e) { return { ok: false, missing: false, error: e } }
  }
  const tmp = get(tmpOf(file))
  if (tmp.ok) return { value: tmp.value, from: 'tmp' }
  const main = get(file)
  if (main.ok) return { value: main.value, from: 'file' }
  if (main.missing) return null   // 대상이 처음부터 없다 — 반쪽 `.tmp` 만 있으면 기록이 아니다
  throw main.error
}

/**
 * 이름 바꾸기만 — 폴더를 옮기는 자리(스킬 폴더 교체·백업)가 쓴다.
 *
 * 디렉터리 이동은 "직접 쓰기" 폴백이 없으므로, 재시도 끝에도 실패하면 **던진다**.
 * 호출부가 잡는지 (§보고서): `agent:install-skill`·`agent:launch` 는 `ipc.ts` 에서 try/catch 로
 * 감싸 오류 결과로 돌려주고, `send()` 는 자기 try/catch 에서 release 후 다시 던져 IPC 가
 * 오류 결과로 바꾼다 — 오류 창으로 새지 않는다.
 */
export function renameWithRetry(from: string, to: string, opts: SafeWriteOptions = {}): void {
  const fs = opts.fs ?? { renameSync }
  const delays = opts.delaysMs ?? RETRY_DELAYS_MS
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (e) {
      if (!RETRY_CODES.has(codeOf(e)) || attempt >= delays.length) throw e
      sleepSync(delays[attempt])
    }
  }
}