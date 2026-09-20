/**
 * GUI 감사 GUI-01·GUI-06: 전송하지 않은 입력이 프로젝트를 넘어가고, 재실행하면 사라진다.
 * 감사자가 손으로 본 것을 그대로 각본으로 옮긴 재현이다.
 */
import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'

const BOX = 'textarea[placeholder="답변을 입력하세요"]'

test('전송하지 않은 초안이 다른 프로젝트로 넘어가지 않는다 (GUI-01)', async () => {
  const a = synthProject()
  const b = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, a)
  await navTo(page, '내 논문')
  await page.fill(BOX, 'A 프로젝트에 쓰다 만 답변')

  await openProject(page, b)
  await navTo(page, '내 논문')
  expect(await page.inputValue(BOX), 'B 프로젝트에 A 의 초안이 보인다').toBe('')

  await openProject(page, a)
  await navTo(page, '내 논문')
  expect(await page.inputValue(BOX), 'A 로 돌아오면 내 초안이 돌아와야 한다')
    .toBe('A 프로젝트에 쓰다 만 답변')
  await electronApp.close()
})

test('앱을 껐다 켜도 초안이 남는다 (GUI-06)', async () => {
  const root = synthProject()
  const userData = mkdtempSync(join(tmpdir(), 'kd-draft-'))

  let app1 = await launch({ userData })
  await openProject(app1.page, root)
  await navTo(app1.page, '내 논문')
  await app1.page.fill(BOX, '쓰다 만 답변')
  await app1.page.waitForTimeout(500)   // 저장이 있다면 쓸 시간
  await app1.electronApp.close()

  const app2 = await launch({ userData })
  await openProject(app2.page, root)
  await navTo(app2.page, '내 논문')
  expect(await app2.page.inputValue(BOX), '재실행 후 초안이 사라졌다').toBe('쓰다 만 답변')
  await app2.electronApp.close()
})
