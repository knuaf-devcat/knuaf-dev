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
 * 보존 규칙(WIN-ONEDRIVE-R1-01): **유일한 완성본은 다시 쓰지 않는다.**
 * - 온전한 대상은 직접 덮어쓰지 않는다 — 이름 바꾸기로만 바뀐다.
 * - 남은 `.tmp` 가 유일한 완성본이면(대상이 없거나 망가짐) 그 `.tmp` 를 다시 쓰기 전에 먼저 대상으로
 *   올린다 — 이름 바꾸기, 막히면 복사(대상이 없거나 망가졌으니 잃을 것이 없다). 올리지 못하면 이번
 *   저장은 건너뛴다(최신 내용은 메모리에 있고 다음 저장이 다시 시도한다).
 * 직접 쓰기 폴백은 기존 대화를 반쪽으로 만들었고(1회째 판정), 대상 없이 `.tmp` 하나만 남은 상태에서
 * 그 `.tmp` 를 다시 쓰다 멈추면 완성본이 하나도 남지 않았다(확인 2회째 반례).
 */

/** 잠깐 막힌 것일 뿐일 수 있는 오류 — 다시 시도해 볼 만하다. */
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** 재시도 사이의 대기(ms). 합계 300ms — main 스레드를 오래 붙잡지 않는다. */
export const RETRY_DELAYS_MS = [20, 40, 80, 160]

export interface SafeWriteFs {
  writeFileSync: typeof writeFileSync
  renameSync: typeof renameSync
  unlinkSync: typeof unlinkSync
  /** 남은 `.tmp`·대상이 완성본인지 볼 때 쓴다 — 없으면 node:fs. */
  readFileSync?: (path: string, encoding: 'utf8') => string
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
  /**
   * 내용이 완전한 기록인가 — 대화 기록은 JSON 모양을 본다. 없으면 "파일이 있다"를 완성으로 본다
   * (초안 글처럼 반쪽인지 알아볼 수 없는 경우).
   */
  complete?: (text: string) => boolean
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
  const read = fs.readFileSync ?? ((path: string) => readFileSync(path, 'utf8'))
  const delays = opts.delaysMs ?? RETRY_DELAYS_MS
  const log = opts.log ?? defaultLog
  const complete = opts.complete ?? (() => true)
  const tmp = tmpOf(file)
  const writeOpts = { encoding: 'utf8' as const, ...(opts.mode === undefined ? {} : { mode: opts.mode }) }
  // 읽지 못한 것(ENOENT 밖)은 "완성본 아님"이 아니라 "모름"이다 — 모르면 지키는 쪽으로 간다.
  const stateOf = (path: string): 'complete' | 'broken' | 'missing' | 'unknown' => {
    let text: string
    try { text = read(path, 'utf8') } catch (e) { return codeOf(e) === 'ENOENT' ? 'missing' : 'unknown' }
    return complete(text) ? 'complete' : 'broken'
  }

  // 재시도 대기는 모든 단계가 함께 쓴다 — 합계가 RETRY_DELAYS_MS 를 넘지 않는다.
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

  // ⓪ 남은 `.tmp` 가 유일한 완성본이면 먼저 대상으로 올린다 — 그 전에는 `.tmp` 를 다시 쓰지 않는다.
  const tmpState = stateOf(tmp)
  const fileComplete = (): boolean => stateOf(file) === 'complete'
  if (tmpState === 'unknown' && !fileComplete()) {
    // `.tmp` 를 읽지 못해 유일한 완성본인지 모른다 — 올리지도 다시 쓰지도 않는다.
    return fail(new Error(`${tmp} 를 읽지 못했어요`), `완성본일 수 있는 ${tmp} 을 지키려고 이번 저장은 건너뛰었어요`)
  }
  if (tmpState === 'complete' && !fileComplete()) {
    let promoted = false
    let last: unknown = null
    for (;;) {
      try { fs.renameSync(tmp, file); promoted = true; break } catch (e) { last = e; if (!retry(e)) break }
    }
    if (!promoted) {
      // 이름 바꾸기가 막혔다 — 복사로 올린다. 대상은 없거나 망가진 상태라 덮어도 잃을 것이 없다.
      try { fs.writeFileSync(file, read(tmp, 'utf8'), writeOpts) } catch (e) { last = e }
      promoted = fileComplete()
    }
    if (!promoted) return fail(last, `완성본 ${tmp} 을 지키려고 이번 저장은 건너뛰었어요`)
  }

  // ① 완성본을 `.tmp` 에 만든다. 중간에 멈춰도 대상은 그대로다(이제 대상이 완성본이거나, `.tmp` 가 기록이 아니다).
  for (;;) {
    try { fs.writeFileSync(tmp, data, writeOpts); break } catch (e) {
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
 * `parse` 는 내용을 검증해 값을 돌려주거나 던진다. 온전한 `.tmp` 는 마지막 쓰기의 이름 바꾸기가
 * 막혔을 때만 남고(성공한 쓰기는 자기 `.tmp` 를 대상으로 옮긴다), 그때 `.tmp` 가 가장 최신이다.
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