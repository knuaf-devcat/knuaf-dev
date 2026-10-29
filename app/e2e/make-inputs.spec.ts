/**
 * 시험주행 발견 17: 검토본이 있으면 합쳐진 본문 파일이 없어도 DOCX를 만들 수 있다.
 * 표지 정보가 없는 경우 앞머리 없이 만든다는 안내와 실제 DOCX가 일치해야 한다.
 */
import { expect, test } from '@playwright/test'
import { launch, navTo, openProject, synthProject } from './helpers'
import { ARTIFACTS } from '../src/renderer/src/copy'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { python } from './helpers'

/** 다시 돌아오면 안 되는 문구 — 한 일을 안 했다고 말하던 옛 캡션. */
const BLAMED_HELPER = ['도우미가 아직 본문을 준비하지 않았어요', '도우미가 재무 값을 아직 준비하지 않았어요']

test('검토본이 나오면 논문 DOCX 버튼이 열린다 (발견 17)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    await navTo(page, '결과물')

    // 만들기 줄은 "왼쪽 이름 + [만들기] 단추" 다(대조 D1-6) — 줄로 집는다.
    const docxRow = page.locator('.make-row').filter({ hasText: ARTIFACTS.make.docx })
    const docx = docxRow.getByRole('button')
    await expect(docx, '합쳐진 본문이 하나도 없으면 잠겨 있는 것이 맞다').toBeDisabled()
    for (const blame of BLAMED_HELPER) await expect(docxRow).not.toContainText(blame)

    // 줄 제목으로 정확히 집는다 — DOCX 줄의 캡션에도 "검토본 만들기"가 들어 있다.
    await page.locator('.make-row').filter({ hasText: new RegExp('^' + ARTIFACTS.make.review) }).getByRole('button').click()
    // 같은 문구가 결과물 시트와 종이 머리 아래 만들기 한 줄 두 곳에 뜬다 — 시트로 좁힌다.
    await expect(page.locator('[data-screen="artifacts"]')).toContainText('검토본을 만들었어요', { timeout: 60_000 })

    await expect(docx, '검토본이 나왔는데도 DOCX 버튼이 잠긴 채였다').toBeEnabled({ timeout: 20_000 })
    // 표지 정보(paper-input.json)가 없으면 앞머리를 못 붙인다. 본문만 묶인다는 것을
    // 말해야 학생이 그것을 제출본으로 오해하지 않는다.
    await expect(docxRow, '겉표지 없이 나온다는 사실을 말하지 않는다').toContainText('겉표지·목차 없이')
    // 실제 변환까지는 여기서 돌리지 않는다 — docx.build 는 프로젝트 .venv 를 요구하고
    // e2e 의 임시 폴더에는 없다(deps_not_ready). 앞머리를 갖춘 본문이 실제로 나오는
    // 것은 tests/test_sidecar.py 와 tests/test_school_paper.py 가 지킨다.
  } finally {
    await electronApp.close()
  }
})


test('QA-03: 본문만 안내에서 만든 DOCX에는 목차 페이지가 없다', async () => {
  test.setTimeout(300_000)
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await navTo(page, '결과물')
    await page.locator('.make-row').filter({ hasText: new RegExp('^' + ARTIFACTS.make.review) }).getByRole('button').click()
    const artifacts = page.locator('[data-screen="artifacts"]')
    await expect(artifacts).toContainText('검토본을 만들었어요', { timeout: 60_000 })
    const docxRow = artifacts.locator('.make-row').filter({ hasText: ARTIFACTS.make.docx })
    await expect(docxRow).toContainText('겉표지·목차 없이')
    const prep = await page.evaluate((root) => window.knuaf.depsEnsure(root), root)
    expect((prep as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    await docxRow.getByRole('button').click()
    await expect(artifacts).toContainText('DOCX를 만들었어요', { timeout: 120_000 })
    // 렌더러 → IPC → 사이드카 → 변환기를 거친 실제 출력. Word 실행/쪽 렌더 검증과는 구분한다.
    const check = spawnSync(python, ['-c', [
      'import json, sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1]) as z:',
      '    xml = z.read("word/document.xml").decode("utf-8")',
      '    settings = z.read("word/settings.xml").decode("utf-8")',
      'print(json.dumps({"toc": "TOC " in xml or ">목차<" in xml, "body": "600평" in xml, "update": "w:updateFields" in settings}))'
    ].join('\n'), join(root, 'build', '검토전_논문.docx')], { encoding: 'utf-8' })
    expect(check.status, check.stdout + check.stderr).toBe(0)
    expect(JSON.parse(check.stdout)).toEqual({ toc: false, body: true, update: false })
  } finally { await electronApp.close() }
})
