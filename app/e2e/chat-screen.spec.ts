// Electron e2e for the "내 논문" screen — 도우미 상태 확인 실패 경로의 복구 UI.
// (인앱 터미널은 제거됐다 — 내 논문은 항상 앱 채팅이다.)
import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'
import { writeCliShim } from './fixtures/fake-codex'

// chat.status RPC가 실패하면 status가 null로 남는다 — 그건 "확인 중"이 아니라 확정된
// 실패다. 툴바의 "연결 확인 중…"이 영원히 남거나 본문이 캡션 하나로 끝나면 안 되고,
// 미연결과 같은 복구 수단(다시 확인·설치 안내·draft 카드)이 보여야 한다.
test('a failed status check is a confirmed failure, not a dead end', async () => {
  // PATH 첫 자리에 즉시 죽는 가짜 codex — status()의 app-server 핸드셰이크가 결정적으로 실패한다.
  const bindir = mkdtempSync(join(tmpdir(), 'kd-bin-'))
  writeCliShim(bindir, 'codex', 'exit 1', 'exit /b 1')
  const root = synthProject()
  const { electronApp, page } = await launch({ env: { PATH: [bindir, '/usr/bin', '/bin'].join(delimiter) } })
  try {
    await openProject(page, root)
    await expect(page.locator('.chat-pane')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('text=도우미 상태를 확인하지 못했어요')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: '다시 확인' })).toBeVisible()
    // "확인 중"은 어느 자리에도 남으면 안 된다 — 아래 칸의 캡션도 포함해서.
    await expect(page.locator('text=연결 확인 중…')).toHaveCount(0)
    // 실패 원문은 입력칸 위 한 줄 알림의 "자세히" 아래로 간다 — 헤드라인은 학생용 문장(알림창 B안).
    const line = page.locator('.chat-zone .zline').first()
    await expect(line).toBeVisible()
    await line.getByRole('button', { name: '자세히' }).click()
    await expect(page.locator('.chat-zone .zline-raw').first()).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

// GUI-10 — 빈 정본에서도 tasks 에 한글 마무리(글꼴·여백·쪽 번호, needs_user)가 섞여
// 온다(gg_core.user_finish_task_list). 그건 도우미의 질문에 대한 "내 답변"이 아니라
// 학생이 한글에서 직접 확인하는 서식 일이라, 어느 자리에서도 질문으로 세면 안 된다.
// (v4 의 "지금 상태 한 줄"은 설계대로 지웠다 — DESIGN §1-3. 그 단언이 지키던 의미를
//  아래 세 자리로 옮긴다.)
test('한글 마무리 항목은 인터뷰 질문으로 세지 않는다 (GUI-10)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })

    // ① 질문 카드가 뜨지 않는다(도우미가 기다리는 질문이 0건이므로).
    await expect(page.locator('.qcard'), '기다리는 질문이 없는데 카드가 떴다').toHaveCount(0)

    // ② 전체 과정의 2단계 사실은 "질문 N개"를 말하지 않는다 — 한글 마무리를 질문으로 세면
    //    이 줄이 바뀐다(질문 0 이면 대신 무엇을 하고 있는지 말한다).
    await page.locator('.titlebar .tbtn.now').click()
    const stage2 = page.locator('.titlebar .popover .pop-row').nth(1)
    await expect(stage2).toContainText('장을 쓰는 중')
    await expect(stage2, '한글 마무리를 질문으로 세고 있다').not.toContainText('질문')
    await page.keyboard.press('Escape')

    // ③ 점검 한 장은 그 일을 자기 자리에서 정확히 센다.
    await navTo(page, '점검')
    await expect(page.locator('[data-screen="checkup"]'))
      .toContainText(/한글에서 내가 직접 할 것 \d+/, { timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})
