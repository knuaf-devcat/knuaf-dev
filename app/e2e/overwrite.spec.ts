/**
 * GUI 감사 GUI-07: 같은 결과물을 두 번 만들면 앱이 덮어쓰기를 거부하는데(옳다),
 * 안내가 "'새 버전 경로' 버튼으로 다른 이름을 고른 뒤 다시 실행해 주세요" 였다.
 * 그 버튼은 화면 어디에도 없다. 학생을 없는 것을 찾게 만든다.
 */
import { expect, test } from '@playwright/test'
import { launch, navTo, openProject, synthProject } from './helpers'

test('이미 만든 결과물을 다시 만들 때 없는 버튼을 찾게 하지 않는다 (GUI-07)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.getByRole('heading', { name: '내 논문' }).waitFor()
    await navTo(page, '결과물')
    await page.click('button:has-text("검토본 만들기")')
    await expect(page.locator('text=검토본을 만들었어요')).toBeVisible({ timeout: 60_000 })

    // 같은 개정에서 한 번 더 — 앱은 덮어쓰지 않는다. 옳은 거절이니 안내가 문제다.
    await page.click('button:has-text("검토본 만들기")')
    // 화면에는 다른 경고(독립검토 미실행)도 있다 — 덮어쓰기 거절 안내만 집는다.
    const fb = page.locator('.feedback').filter({ hasText: '덮어쓰' }).first()
    await expect(fb).toBeVisible({ timeout: 60_000 })

    const text = await fb.innerText()
    // 화면에 없는 조작을 시키지 않는다.
    expect(text, '없는 "새 버전 경로" 버튼을 누르라고 한다').not.toContain('새 버전 경로')
    for (const label of ['새 버전 경로', '새 경로를 쓰세요']) expect(text).not.toContain(label)
    // 실제로 일어난 일을 말해야 한다 — 그 파일은 이미 있다.
    // 실제로 있는 곳을 가리켜야 한다 — 그 파일은 아래 목록에 있다.
    expect(text, '실제로 할 수 있는 일을 말해야 한다').toContain('목록')
  } finally {
    await electronApp.close()
  }
})
