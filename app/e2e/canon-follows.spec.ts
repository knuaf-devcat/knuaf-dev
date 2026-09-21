/**
 * 시험주행 발견 13: 점검 화면이 폴더를 연 순간의 상태를 계속 붙들고 있었다.
 * 도우미가 개정 19까지 저장한 뒤에도 화면은 "0번째 기록 · 고칠 곳 0 — 고칠 곳이
 * 없어요"였다. 실제로는 자동 점검 실패가 60건이었고, "고칠 곳이 없어요"는 학생이
 * 다 됐다고 읽는 문장이다. 새로고침을 눌러야만 진실이 나오는 것을 학생은 알 수 없다.
 *
 * 여기서 거는 것은 "저절로 따라온다" 하나다. 무엇이 실패인지는 검사기의 몫이라
 * 숫자를 고정하지 않고, 화면이 디스크의 정본보다 뒤처진 채 남지 않는 것만 본다.
 * 정본을 바꾸는 주체는 흉내 내지 않는다 — 앱 안 채팅이든 외부 터미널이든 앱은
 * 어느 쪽이든 알아채야 한다.
 */
import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, navTo, openProject, python, scripts, synthProject } from './helpers'

test('도우미가 저장하면 점검 화면이 새로고침 없이 따라온다 (발견 13)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await navTo(page, '점검')
    const badge = page.locator('header.toolbar .badge')
    await expect(badge).toHaveText('1번째 기록', { timeout: 20_000 })

    // 도우미가 한 것과 같은 일 — 절을 하나 더 등록해 정본을 2번째 기록으로 올린다.
    writeFileSync(join(root, 'sections', '02.md'), '# Ⅱ. 농장 현황\n\n<!-- gg:draft:start -->\n농장A는 정읍에 있다.\n<!-- gg:draft:end -->\n', 'utf-8')
    const change = join(root, 'change2.json')
    writeFileSync(change, JSON.stringify({ request_id: 'e2e:2', ops: [
      { collection: 'sections', value: { id: 'sec-02', title: 'Ⅱ. 농장 현황', order: 2, path: 'sections/02.md', status: 'drafting' } }
    ] }), 'utf-8')
    const a = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', '1'], { encoding: 'utf-8' })
    expect(a.status, a.stdout + a.stderr).toBe(0)

    // 새로고침을 누르지 않는다.
    await expect(badge, '정본이 올랐는데 점검 화면이 옛 기록에 머물렀다').toHaveText('2번째 기록', { timeout: 30_000 })
    await expect(page.locator('nav .project-chip'), '사이드바도 같이 따라와야 한다').toContainText('2번째 기록')
  } finally {
    await electronApp.close()
  }
})
