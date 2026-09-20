/**
 * GUI 감사 GUI-02: 도우미가 정본을 만든 뒤 작업을 중단하면 왼쪽 메뉴가 잠긴 채 남고,
 * 같은 폴더를 다시 열어야 풀렸다.
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
import { launch, openProject, python, scripts } from './helpers'

test('폴더를 연 뒤 정본이 생기면 앱이 알아챈다 (GUI-02)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-noproj-'))   // 정본 없는 빈 폴더
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.getByRole('heading', { name: '내 논문' }).waitFor()
    const checkup = page.locator('nav').getByRole('button', { name: '점검', exact: true })
    await expect(checkup, '정본이 없으면 메뉴가 잠겨 있어야 한다').toBeDisabled()

    const r = spawnSync(python, [join(scripts, 'gg.py'), 'init', root], { encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)

    await expect(checkup, '정본이 생겼는데 메뉴가 잠긴 채로 남았다').toBeEnabled({ timeout: 20_000 })
  } finally {
    await electronApp.close()
  }
})
