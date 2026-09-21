/**
 * 시험주행 발견 17·18: "파일 만들기"의 두 버튼이 잠긴 채, 잠긴 이유를 도우미 탓으로
 * 돌렸다.
 *
 * 17 — Ⅰ~Ⅶ 전 장을 쓰고 검토본(60KB)까지 나온 뒤에도 "논문 DOCX 만들기"가
 *      "도우미가 아직 본문을 준비하지 않았어요"였다. 앱이 `build/검토전_본문.md`
 *      한 이름만 본문으로 인정했기 때문이다. 학생은 채팅에 가서 이미 한 일을 다시
 *      요청하고 도우미는 이미 했다고 답하는 고리에 갇힌다.
 * 18 — "재무 엑셀 만들기"는 "도우미가 재무 값을 아직 준비하지 않았어요"였는데,
 *      실제로 없는 것은 값이 아니라 학생이 내놓아야 할 학교 재무 양식 원본이다.
 *
 * 여기서 거는 것은 둘: 검토본이 있으면 DOCX 를 만들 수 있다, 그리고 잠긴 이유를
 * 도우미 탓으로 말하지 않는다.
 */
import { expect, test } from '@playwright/test'
import { launch, navTo, openProject, synthProject } from './helpers'
import { ARTIFACTS } from '../src/renderer/src/copy'

/** 다시 돌아오면 안 되는 문구 — 한 일을 안 했다고 말하던 옛 캡션. */
const BLAMED_HELPER = ['도우미가 아직 본문을 준비하지 않았어요', '도우미가 재무 값을 아직 준비하지 않았어요']

test('검토본이 나오면 논문 DOCX 버튼이 열린다 (발견 17)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.getByRole('heading', { name: '내 논문' }).waitFor()
    await navTo(page, '결과물')

    const docx = page.getByRole('button', { name: ARTIFACTS.make.docx, exact: true })
    const docxRow = page.locator('.make-row').filter({ hasText: ARTIFACTS.make.docx })
    await expect(docx, '합쳐진 본문이 하나도 없으면 잠겨 있는 것이 맞다').toBeDisabled()
    for (const blame of BLAMED_HELPER) await expect(docxRow).not.toContainText(blame)

    await page.click(`button:has-text("${ARTIFACTS.make.review}")`)
    await expect(page.locator('text=검토본을 만들었어요')).toBeVisible({ timeout: 60_000 })

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

test('재무 엑셀이 잠긴 이유를 도우미 탓으로 말하지 않는다 (발견 18)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.getByRole('heading', { name: '내 논문' }).waitFor()
    await navTo(page, '결과물')

    const xlsxRow = page.locator('.make-row').filter({ hasText: ARTIFACTS.make.xlsx })
    for (const blame of BLAMED_HELPER) await expect(xlsxRow).not.toContainText(blame)
    // 없는 것을 이름으로 말하고, 누가 내놓는 것인지도 말한다.
    await expect(xlsxRow).toContainText('학교 재무 양식')
  } finally {
    await electronApp.close()
  }
})
