// Unit tests for src/renderer/src/paths.ts — plain Playwright `test()` in Node: no Electron.
//
// `joinPath` 는 `window.knuaf.platform` 을 보므로, Electron 을 띄우지 않고 그 값만 갈아 끼워
// 두 플랫폼 분기를 **호스트와 무관하게** 고정한다(맥에서도 윈도우 분기를, 윈도우에서도 POSIX
// 분기를 검사한다).
import { expect, test } from '@playwright/test'
import { joinPath } from '../src/renderer/src/paths'

type Platform = 'darwin' | 'win32'
const g = globalThis as { window?: unknown }

function withPlatform<T>(platform: Platform, fn: () => T): T {
  const real = g.window
  g.window = { knuaf: { platform } }
  try { return fn() } finally { g.window = real }
}

/**
 * 검토 W1B-R1-01. macOS 에서 역슬래시는 **파일명에 들어갈 수 있는 글자**다 — 그래서
 * `build/probe\review.docx` 와 `build/probe/review.docx` 는 서로 다른 두 파일이다.
 * 구분자 통일을 POSIX 까지 적용하면 앞의 것을 뒤의 것으로 바꿔 **다른 파일을 연다**.
 */
test('POSIX 에서는 rel 의 역슬래시를 구분자로 바꾸지 않는다 (W1B-R1-01)', () => {
  withPlatform('darwin', () => {
    const root = '/Users/s/논문'
    const backslash = joinPath(root, 'build/probe\\review.docx')
    const slash = joinPath(root, 'build/probe/review.docx')
    // 불변식: 맥에서 joinPath(root, rel) = root + '/' + rel (rel 은 그대로).
    expect(backslash).toBe('/Users/s/논문/build/probe\\review.docx')
    expect(slash).toBe('/Users/s/논문/build/probe/review.docx')
    // 그리고 둘은 **다른 경로**다 — 같은 열기 경로로 가면 안 된다.
    expect(backslash, '서로 다른 두 파일이 같은 경로로 열린다').not.toBe(slash)
    // 평범한 중첩 경로는 종전 그대로다.
    expect(joinPath(root, 'build/1/review/검토용.md')).toBe('/Users/s/논문/build/1/review/검토용.md')
    // 루트가 없으면 rel 그대로.
    expect(joinPath(null, 'build/probe\\review.docx')).toBe('build/probe\\review.docx')
  })
})

/** 윈도우에서는 `/` 와 `\` 가 같은 구분자라 통일해도 파일이 달라지지 않는다(G7 의 본래 목적). */
test('win32 에서만 구분자를 역슬래시로 통일한다', () => {
  withPlatform('win32', () => {
    const root = 'C:\\논문'
    expect(joinPath(root, 'build/1/review/검토용.md')).toBe('C:\\논문\\build\\1\\review\\검토용.md')
    expect(joinPath(root, 'build\\1\\review\\검토용.md')).toBe('C:\\논문\\build\\1\\review\\검토용.md')
    // 윈도우의 두 표기는 같은 파일이다 — 여기서는 통일이 맞다.
    expect(joinPath(root, 'build/probe\\review.docx')).toBe(joinPath(root, 'build/probe/review.docx'))
  })
})
