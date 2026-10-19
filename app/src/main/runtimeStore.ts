/**
 * 설치 폴더의 게시 상태·정리 — Electron 에 기대지 않는 순수 부분.
 *
 * `runtime.ts` 가 userData 경로를 넘기고, 시험(e2e/runtime-store.spec.ts)은 임시 폴더로
 * 같은 소스를 그대로 돌린다. 여기서 지키는 계약(§7 PY-D1-01):
 * - 도장이 **확실히 없는**(ENOENT) 폴더만 미완성이다.
 * - 도장을 읽지 못한 폴더는 보존한다 — 권한·손상일 수 있고, 그 기반 Python 을 닫힌
 *   프로젝트의 venv 가 참조한다. "선택에서 빠짐"과 "삭제"는 다른 판정이다(PY-C1-01).
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const STAMP = '.knuaf-runtime.json'
/** 도장 폴더 이름의 꼬리(설치 시각 ms) — 가장 최근 설치를 고르는 데 쓴다. */
export const INSTALL_DIR_RE = /^cpython-.*-(\d+)$/

export interface Stamp { version: string; release: string; target: string; sha256: string }

/**
 * 도장의 세 가지 상태. `null` 하나로 뭉치면 "없다"와 "읽지 못했다"가 같아진다.
 * - `ok`: 게시된 폴더다.
 * - `absent`: 도장 파일이 없다(ENOENT) — 미완성 설치. 정리 대상.
 * - `unreadable`: 파일은 있는데 권한·JSON·필드 문제로 못 읽었다 — 지우지 않는다.
 */
export type StampState = { kind: 'ok'; stamp: Stamp } | { kind: 'absent' } | { kind: 'unreadable'; reason: string }

export function stampState(dir: string): StampState {
  let text: string
  try {
    text = readFileSync(join(dir, STAMP), 'utf-8')
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', reason: `${code || 'read'} ${String(error)}` }
  }
  // 디스크에서 온 JSON — 네 필드의 typeof 를 모두 확인한 뒤에만 통과시킨다.
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { kind: 'unreadable', reason: `JSON ${String(error)}` }
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'unreadable', reason: 'JSON 이 객체가 아님' }
  const { version, release, target, sha256 } = parsed as Record<string, unknown>
  if (typeof version !== 'string' || typeof release !== 'string' || typeof target !== 'string' || typeof sha256 !== 'string') {
    return { kind: 'unreadable', reason: '도장 필드 형식 오류' }
  }
  return { kind: 'ok', stamp: { version, release, target, sha256 } }
}

/** 도장·marker가 현재 명세와 맞는 설치 중 가장 최근 것. smoke 확인은 하지 않는다(선택은 동기). */
export function findInstallIn(root: string, spec: { version: string; release: string; targets: Record<string, { sha256: string }> }, target: string, marker: string): string | null {
  let names: string[]
  try { names = readdirSync(root) } catch { return null }
  let best: { dir: string; ms: number } | null = null
  for (const name of names) {
    const m = INSTALL_DIR_RE.exec(name)
    if (!m) continue
    const dir = join(root, name)
    const state = stampState(dir)
    if (state.kind !== 'ok') continue
    const expected = spec.targets[target]
    if (!expected) continue
    const { stamp } = state
    if (stamp.version !== spec.version || stamp.release !== spec.release || stamp.target !== target || stamp.sha256 !== expected.sha256) continue
    if (!existsSync(join(dir, marker))) continue
    const ms = Number(m[1])
    if (!best || ms > best.ms) best = { dir, ms }
  }
  return best?.dir ?? null
}

/**
 * 앱 시작·설치 성공 뒤 정리. **도장이 확실히 없는** 설치 폴더와 임시 다운로드만 지운다.
 * 게시된 폴더와 도장을 읽지 못한 폴더는 어떤 경우에도 지우지 않는다.
 */
export function cleanupRuntimeAt(root: string): void {
  let names: string[]
  try { names = readdirSync(root) } catch { return }
  for (const name of names) {
    const isInstall = INSTALL_DIR_RE.test(name)
    const isTemp = name.startsWith('.download-')
    if (!isInstall && !isTemp) continue
    if (isInstall && stampState(join(root, name)).kind !== 'absent') continue
    try { rmSync(join(root, name), { recursive: true, force: true }) } catch { /* 다음 시작에 다시 시도 */ }
  }
}
