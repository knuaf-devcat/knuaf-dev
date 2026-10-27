/**
 * GUI 감사 GUI-01·GUI-06: 전송하지 않은 입력이 프로젝트를 넘어가고, 재실행하면 사라진다.
 * 감사자가 손으로 본 것을 그대로 각본으로 옮긴 재현이다.
 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'
import { fakeCodexEnv, scratch, userDataWith } from './fixtures/fake-codex'

const BOX = 'textarea[aria-label="답변을 입력하세요"]'


test('전송하지 않은 초안이 다른 프로젝트로 넘어가지 않는다 (GUI-01)', async () => {
  const a = synthProject()
  const b = synthProject()
  const dir = scratch()
  const userData = userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' } })
  const { electronApp, page } = await launch({ userData, env: fakeCodexEnv(join(dir, 'bin')) })
  await openProject(page, a)
  await navTo(page, '내 논문')
  await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨')
  await page.fill(BOX, 'A 프로젝트에 쓰다 만 답변')

  await openProject(page, b)
  await navTo(page, '내 논문')
  await expect(page.locator(BOX), 'B 프로젝트에 A 의 초안이 보인다').toHaveValue('')

  await openProject(page, a)
  await navTo(page, '내 논문')
  await expect(page.locator(BOX), 'A 로 돌아오면 내 초안이 돌아와야 한다').toHaveValue('A 프로젝트에 쓰다 만 답변')
  await electronApp.close()
})

test('앱을 껐다 켜도 초안이 남는다 (GUI-06)', async () => {
  const root = synthProject()
  const dir = scratch()
  const userData = userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' } })
  const env = fakeCodexEnv(join(dir, 'bin'))

  const app1 = await launch({ userData, env })
  await openProject(app1.page, root)
  await navTo(app1.page, '내 논문')
  await expect(app1.page.getByTitle('이 논문의 도우미')).toContainText('연결됨')
  await app1.page.fill(BOX, '쓰다 만 답변')
  // 잠들 필요 없다 — 종료 직전에 메인이 동기로 쓴다.
  await app1.electronApp.close()
  expect(readFileSync(join(root, '.knuaf-gui', 'draft.txt'), 'utf8')).toBe('쓰다 만 답변')

  const app2 = await launch({ userData, env })
  await openProject(app2.page, root)
  await navTo(app2.page, '내 논문')
  try {
    // A안부터 입력칸이 연결 확인보다 먼저 뜬다. 저장 초안의 비동기 복원을 기다린다.
    await expect(app2.page.locator(BOX), '재실행 후 초안이 사라졌다').toHaveValue('쓰다 만 답변')
  } finally { await app2.electronApp.close() }
})
