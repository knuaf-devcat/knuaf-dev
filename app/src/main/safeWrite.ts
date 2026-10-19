import { renameSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * 학생 논문 폴더에 파일을 남기는 **공용 쓰기** (WIN-ONEDRIVE).
 *
 * 왜 필요한가: 윈도우에서 논문 폴더가 OneDrive 동기화 폴더(예: `OneDrive\바탕 화면\…`)이면,
 * 동기화 클라이언트·백신·검색 색인이 그 순간 파일을 쥐고 있어 `renameSync` 가
 * `EPERM: operation not permitted` 로 실패한다. 그 예외가 **main 프로세스의 이벤트 콜백**에서
 * 올라오면 Electron 이 "A JavaScript error occurred in the main process" 오류 창을 띄운다 —
 * 형님 윈도우 노트북에서 실제로 그랬다(`ChatService.publish`).
 *
 * 규칙: ① 원자적 쓰기(임시 파일 → 이름 바꾸기)를 먼저 시도하고 ② 다시 시도해 볼 만한 오류면
 * 짧게 재시도하며(main 스레드를 오래 막지 않게 합계 수백 ms 이하) ③ 그래도 안 되면 대상 파일에
 * **직접 쓰기**로 내려가고 ④ 그것도 실패하면 **던지지 않고** 실패를 돌려준다. 남은 `.tmp` 는 치운다.
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

export type WriteResult = { ok: true; fallback?: true } | { ok: false; error: Error }

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
  const tmp = `${file}.tmp`
  const write = (path: string): void => { fs.writeFileSync(path, data, { encoding: 'utf8', ...(opts.mode === undefined ? {} : { mode: opts.mode }) }) }

  let last: Error = new Error('파일을 저장하지 못했어요')
  for (let attempt = 0; ; attempt++) {
    try {
      write(tmp)
      fs.renameSync(tmp, file)
      return { ok: true }
    } catch (e) {
      last = asError(e)
      if (!RETRY_CODES.has(codeOf(e)) || attempt >= delays.length) break
      sleepSync(delays[attempt])
    }
  }

  // 비원자 폴백 — 동기화 클라이언트가 **rename 만** 막는 일이 흔하다(직접 쓰기는 통과한다).
  try {
    write(file)
    try { fs.unlinkSync(tmp) } catch { /* 이미 없다 */ }
    log(`[knuaf] 원자적 저장이 막혀 직접 썼어요: ${file} (${codeOf(last) || last.message})`)
    return { ok: true, fallback: true }
  } catch (e) {
    last = asError(e)
  }

  // 남은 `.tmp` 를 남기지 않는다 — 다음 실행이 "임시 파일"을 모른 채 지나가면 영원히 쌓인다.
  try { fs.unlinkSync(tmp) } catch { /* 이미 없다 */ }
  log(`[knuaf] 파일을 저장하지 못했어요: ${file} (${codeOf(last) || last.message})`)
  return { ok: false, error: last }
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