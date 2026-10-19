// PY-C1-01 회귀 시험 — 게시된 런타임은 정리가 지우지 않는다.
//
// 검토자가 쓴 재현 그대로: 정상 설치·게시 뒤 **도장만** 읽을 수 없게 만들고(chmod 000)
// 정리를 부른다. 소스(`src/main/runtimeStore.ts`)를 Electron 없이 그대로 import 해서 돌린다.
import { expect, test } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupRuntimeAt, findInstallIn, stampState } from '../src/main/runtimeStore'

const WIN = process.platform === 'win32'
const TARGET = 'aarch64-apple-darwin'
const SPEC = { version: '3.12.11', release: '20250918', targets: { [TARGET]: { sha256: 'a'.repeat(64) } } }

/** 도장 있는 설치 폴더 하나(실행 파일 포함). */
function install(root: string, name: string, stamp: object | null = { version: '3.12.11', release: '20250918', target: TARGET, sha256: 'a'.repeat(64) }): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'python3'), '#!/bin/sh\n', { mode: 0o755 })
  if (stamp) writeFileSync(join(dir, '.knuaf-runtime.json'), JSON.stringify(stamp), 'utf-8')
  return dir
}

test('도장을 읽지 못한 게시 폴더는 정리가 지우지 않는다 (PY-C1-01)', () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-runtime-store-'))
  const dir = install(root, 'cpython-3.12.11+20250918-aarch64-apple-darwin-1000')
  if (!WIN) chmodSync(join(dir, '.knuaf-runtime.json'), 0o000)
  // 전제: 도장은 있다(읽기만 실패한다). 파일이 없는 것과 구분되는 상태여야 한다.
  expect(existsSync(join(dir, '.knuaf-runtime.json'))).toBe(true)
  expect(stampState(dir).kind).toBe(WIN ? 'ok' : 'unreadable')

  cleanupRuntimeAt(root)

  expect(existsSync(dir), '읽지 못한 도장의 게시 폴더가 지워졌다').toBe(true)
  expect(existsSync(join(dir, 'bin', 'python3'))).toBe(true)
  if (!WIN) chmodSync(join(dir, '.knuaf-runtime.json'), 0o644)
})

test('도장이 없는 미완성 폴더와 임시 다운로드만 지운다', () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-runtime-store-'))
  const incomplete = install(root, 'cpython-3.12.11+20250918-aarch64-apple-darwin-2000', null)
  const published = install(root, 'cpython-3.12.11+20250918-aarch64-apple-darwin-3000')
  const temp = join(root, '.download-4000.tar.gz')
  writeFileSync(temp, 'partial')

  cleanupRuntimeAt(root)

  expect(existsSync(incomplete)).toBe(false)
  expect(existsSync(temp)).toBe(false)
  expect(existsSync(published)).toBe(true)
})

test('깨진 도장(JSON·필드)도 게시 폴더로 보존하고, 선택에서는 빠진다', () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-runtime-store-'))
  const broken = join(root, 'cpython-3.12.11+20250918-aarch64-apple-darwin-5000')
  mkdirSync(join(broken, 'bin'), { recursive: true })
  writeFileSync(join(broken, 'bin', 'python3'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(join(broken, '.knuaf-runtime.json'), '{ not json', 'utf-8')
  expect(stampState(broken).kind).toBe('unreadable')

  cleanupRuntimeAt(root)

  expect(existsSync(broken)).toBe(true)
  expect(findInstallIn(root, SPEC, TARGET, join('bin', 'python3'))).toBeNull()
})
