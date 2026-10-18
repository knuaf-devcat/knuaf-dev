/**
 * GUI 감사 GUI-02: 도우미가 정본을 만든 뒤 작업을 중단하면 왼쪽 메뉴가 잠긴 채 남고,
 * 같은 폴더를 다시 열어야 풀렸다.
 *
 * v5 에는 잠기는 목적지가 없다(시트는 언제나 열린다) — 그래서 "메뉴가 풀린다"를 볼 수 없다.
 * 대신 **앱이 정본이 생긴 것을 알아채는가**를 본다: 정본이 없으면 읽은 상태가 없으므로
 * 점검 한 장에 기록 번호가 없고, 정본이 생기면 새로고침 없이 그 자리에 나타난다.
 *
 * 테스트는 "누가 만들었는지"를 흉내 내지 않는다. 정본을 만드는 길은 앱 안 채팅만이
 * 아니라 외부 터미널의 스킬 실행도 있고, 앱은 어느 쪽이든 알아채야 하기 때문이다.
 * 폴더를 연 상태에서 정본이 생기는 것 하나만 만든다.
 */
import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSectionBody, launch, navTo, openProject, python, scripts } from './helpers'

test('폴더를 연 뒤 정본이 생기면 앱이 알아챈다 (GUI-02)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-noproj-'))   // 정본 없는 빈 폴더
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })

    await navTo(page, '점검')
    const sheet = page.locator('[data-screen="checkup"]')
    await sheet.waitFor({ timeout: 30_000 })
    await expect(sheet, '정본이 없는데 기록 번호를 말하고 있다').not.toContainText('번째 기록')

    const r = spawnSync(python, [join(scripts, 'gg.py'), 'init', root], { encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)

    // 새로고침을 누르지 않아도 앱이 알아챈다 — 시트 머리에 기록이 나타난다(init 은 0번째 기록).
    await expect(sheet, '정본이 생겼는데 앱이 모른 채 남았다').toContainText('0번째 기록', { timeout: 30_000 })

    // 한 번 더 저장하면 기록이 오른다 — 그 뒤에도 앱이 스스로 따라온다.
    addSectionBody(root, { expected: 0 })
    await expect(sheet).toContainText('1번째 기록', { timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})
