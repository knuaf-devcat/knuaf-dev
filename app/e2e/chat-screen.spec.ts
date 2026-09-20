// Electron e2e for the "내 논문" screen — 도우미 상태 확인 실패 경로의 복구 UI.
// (인앱 터미널은 제거됐다 — 내 논문은 항상 앱 채팅이다.)
import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'

// chat.status RPC가 실패하면 status가 null로 남는다 — 그건 "확인 중"이 아니라 확정된
// 실패다. 툴바의 "연결 확인 중…"이 영원히 남거나 본문이 캡션 하나로 끝나면 안 되고,
// 미연결과 같은 복구 수단(다시 확인·설치 안내·draft 카드)이 보여야 한다.
test('a failed status check is a confirmed failure, not a dead end', async () => {
  // PATH 첫 자리에 즉시 죽는 가짜 codex — status()의 app-server 핸드셰이크가 결정적으로 실패한다.
  const bindir = mkdtempSync(join(tmpdir(), 'kd-bin-'))
  writeFileSync(join(bindir, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const root = synthProject()
  const { electronApp, page } = await launch({ env: { PATH: `${bindir}:/usr/bin:/bin` } })
  try {
    await openProject(page, root)
    await expect(page.locator('h1', { hasText: '내 논문' })).toBeVisible()
    await expect(page.locator('text=도우미 상태를 확인하지 못했어요')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: '다시 확인' })).toBeVisible()
    // "확인 중"은 어느 자리에도 남으면 안 된다 — 툴바 배지와 본문 캡션 둘 다.
    await expect(page.locator('text=연결 확인 중…')).toHaveCount(0)
    // 실패 원문은 피드백 카드의 "자세히" 아래로 간다 — 헤드라인은 학생용 문장.
    await expect(page.locator('.feedback').first()).toBeVisible()
    await expect(page.locator('.feedback summary:has-text("자세히")').first()).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

// GUI-10 — 빈 정본에서도 tasks 에 한글 마무리(글꼴·여백·쪽 번호, needs_user)가 섞여
// 온다(gg_core.user_finish_task_list). 그건 도우미의 질문에 대한 "내 답변"이 아니라
// 학생이 한글에서 직접 확인하는 서식 일이라, 상태 한 줄도 그렇게 불러야 한다.
test('the state line names manual finishing work, not "my replies"', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('h1:has-text("내 논문")', { timeout: 30_000 })
    const line = page.locator('.state-line')
    await expect(line).toBeVisible({ timeout: 30_000 })
    await expect(line).toContainText('직접 확인')
    await expect(line).not.toContainText('내 답변')
  } finally {
    await electronApp.close()
  }
})
