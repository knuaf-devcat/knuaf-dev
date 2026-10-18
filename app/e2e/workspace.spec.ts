/**
 * 단계 3-B — 두 칸·제목줄·화면 흡수 (IMPL-PLAN §5 단계 3 완료 기준).
 *
 * 폭 경계의 세부(1,139/1,140/1,219/1,220 과 대화 칸 460/539/540)는 창을 띄우지 않고
 * `layout.spec.ts` 가 Node 단위로 고정한다. 여기서는 실제 창에서 한 번씩만 밟는다.
 *
 * 아직 채우지 않은 항목(3-A 합류 뒤): "지금" 표시 개수(닫힘·열림 각 1), 권하는 단추,
 * 파일 현재성 점(`project.load` 의 `outputs[*].stale`), 검토본 만들기 켜짐 조건
 * (`fs.build_tree` 의 review 개정). 그 셋은 `shared/stage.ts` 와 `rpc.ts` 에 있고
 * 그 파일들은 3-A 워커의 것이다.
 */
import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { addSectionBody, launch, markSectionReady, openProject, setWindowWidth, synthProject } from './helpers'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'

test('본문이 없으면 한 칸, 첫 장이 저장되면 두 칸이 된다', async () => {
  const root = synthProject({ withContent: false })
  const { electronApp, page } = await launch()
  await openProject(page, root)

  // 아직 쓴 글이 없다 — 빈 종이로 옆 칸을 채우지 않는다(DESIGN §1-1).
  await expect(page.locator('.paperpane')).toHaveCount(0)
  await expect(page.locator('.chat-pane')).toBeVisible()
  // 제목줄이 왜 옆 칸이 비었는지 말한다(시안 ③).
  await expect(page.locator('.titlebar')).toContainText('첫 장을 쓰면')

  // 첫 절 본문이 저장된다. 정본 감시(2초)가 기록이 오른 것을 보고 다시 읽는다.
  addSectionBody(root)
  await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.chat-pane')).toBeVisible()
  // 종이에는 저장된 글만 있다.
  await expect(page.locator('.paperpane .sheet')).toContainText('농장A의 재배 면적은 600평이다')
  await electronApp.close()
})

test('두 칸이 되면 대화 칸 폭이 규칙대로다 (1,140 → 460)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })

  await setWindowWidth(electronApp, 1140)
  const width = await page.locator('.chat-pane').evaluate((el) => el.getBoundingClientRect().width)
  expect(Math.round(width)).toBe(460)
  // 종이는 최소 680 이상을 가져간다.
  const paper = await page.locator('.paperpane').evaluate((el) => el.getBoundingClientRect().width)
  // 소수점 이하가 있다(679.9999…) — 반올림해 견준다.
  expect(Math.round(paper)).toBeGreaterThanOrEqual(680)
  await electronApp.close()
})

test('좁은 창(1,139)에서는 한 칸 + 제목줄 바꾸기', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })

  await setWindowWidth(electronApp, 1000)
  // 바꾸기가 나오고, 논문 칸은 화면에서 빠진다(⑯).
  await expect(page.locator('.tbar-seg')).toBeVisible()
  await expect(page.locator('.paperpane')).toHaveCount(0)
  await expect(page.locator('.chat-pane')).toBeVisible()

  await page.locator('.tbar-seg').getByRole('tab', { name: '내 논문' }).click()
  await expect(page.locator('.paperpane')).toBeVisible()
  await expect(page.locator('.chat-pane')).toHaveCount(0)

  // 다시 넓히면 두 칸으로 돌아온다.
  await setWindowWidth(electronApp, 1280)
  await expect(page.locator('.chat-pane')).toBeVisible()
  await expect(page.locator('.paperpane')).toBeVisible()
  await electronApp.close()
})

test('종이를 닫으면 다시 저절로 열리지 않는다', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: '내 논문 닫기' }).click()
  await expect(page.locator('.paperpane')).toHaveCount(0)
  await expect(page.locator('.tbar-seg')).toBeVisible()

  // 기록이 올라도 닫아 둔 것은 닫힌 채다(설계 §4-2).
  addSectionBody(root, { id: 'sec-02', title: 'Ⅱ. 농장 소개', body: '새벽빛 농원은 해 뜨기 전에 딴다.', expected: 1 })
  await page.waitForTimeout(4_000)
  await expect(page.locator('.paperpane')).toHaveCount(0)

  // 다시 여는 것은 학생의 선택이다 — 설정에 남는다.
  await page.locator('.tbar-seg').getByRole('tab', { name: '내 논문' }).click()
  await expect(page.locator('.paperpane')).toBeVisible()
  await electronApp.close()
})

test('제출 전 점검 한 장이 논문 칸을 덮고, 확인 행이 네 개다', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })

  // 정식 진입점: 제목줄 "지금 ▾" → 전체 과정 → 제출 점검·마무리 줄(설계자 답 Q6).
  await page.locator('.titlebar .tbtn.now').click()
  await page.locator('.titlebar .popover').getByRole('button', { name: /제출 점검·마무리/ }).click()

  const over = page.locator('.paperpane .sheetover')
  await expect(over).toBeVisible()
  await expect(over.getByRole('heading')).toContainText('제출 전 점검')
  // 네 갈래는 합치지 않고 행 네 개로 따로.
  await expect(over.locator('.lanes .ln')).toHaveCount(4)
  await expect(over).toContainText('자동 점검')
  await expect(over).toContainText('다른 사람 검토')
  await expect(over).toContainText('파일 확인')
  await expect(over).toContainText('교수님 승인')
  // 한글에서 내가 직접 할 것 — 앱이 대신 못 하는 일.
  await expect(over).toContainText('한글에서 내가 직접 할 것')
  // 퍼센트·진행 막대·완료 배지는 쓰지 않는다.
  expect(await over.locator('[role=progressbar], progress').count()).toBe(0)
  expect(await over.locator('button:has-text("완료")').count()).toBe(0)
  await electronApp.close()
})

test('"지금"은 닫혀 있을 때도 열려 있을 때도 한 곳뿐이다 (3-A 완료 기준)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })

  const now = page.locator('.titlebar .tbtn.now')
  // 닫힘: 단추가 "지금 · ○○" 한 줄로 말한다.
  await expect(now).toContainText('지금')
  await expect(page.locator('.titlebar .popover')).toHaveCount(0)
  await now.click()
  // 열림: 단추 글자는 "전체 과정"으로 바뀌고(검토 R1-02), "지금" 표시는 목록 한 줄에만 있다.
  await expect(now).toContainText('전체 과정')
  await expect(now).not.toContainText('지금')
  const pop = page.locator('.titlebar .popover')
  await expect(pop).toBeVisible()
  await expect(pop.locator('.pop-row')).toHaveCount(5)
  await expect(pop.locator('.now-w')).toHaveCount(1)
  await electronApp.close()
})

test('종이 머리 권하는 단추 — 3단계에서 "검토본 만들기" 하나 (3-A 합류)', async () => {
  // "지금"이 1단계(준비)로 떨어지지 않으려면 연결이 확인돼야 한다 — 가짜 codex(logged-in)로
  // 고정한다. 개발 기계에 진짜 CLI 가 있든 없든 같은 장면이 되게 하려는 것이다(fixtures).
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  await openProject(page, root)
  await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })

  // 처음에는 인터뷰 단계(2)라 권하는 단추가 없다 — 대화가 이끈다(DESIGN §2).
  await expect(page.locator('.titlebar .tbtn.now')).toContainText('인터뷰')
  await expect(page.locator('.paper-head button.primary')).toHaveCount(0)

  // 장을 다 쓴 상태로 올린다(기록 +1) → 2초 감시가 다시 읽고 3단계가 된다.
  markSectionReady(root)
  await expect(page.locator('.paper-head button.primary')).toHaveText('검토본 만들기', { timeout: 20_000 })
  await expect(page.locator('.titlebar .tbtn.now')).toContainText('검토본')
  await electronApp.close()
})

test('팝오버 — 만든 파일과 만들기 네 줄이 종이 머리에서 열린다', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })

  await page.locator('.paper-head').getByRole('button', { name: /파일/ }).click()
  const pop = page.locator('.paperpane .popover')
  await expect(pop).toBeVisible()
  // 만들기 4줄(v2 §4-2 조건 그대로) — 인터뷰 중에도 검토본은 켜져 있다.
  await expect(pop.locator('.pop-make')).toHaveCount(4)
  await expect(pop).toContainText('검토본 만들기')
  await expect(pop).toContainText('제출용 파일 만들기')
  // 줄 제목으로 집는다 — 캡션에도 "검토본 만들기"가 들어간 줄이 있어 `:has-text` 로는 두 줄이 걸린다.
  await expect(pop.locator('.pop-make:has(b:text-is("검토본 만들기")) button')).toBeEnabled()
  // Esc 로 닫힌다.
  await page.keyboard.press('Escape')
  await expect(page.locator('.paperpane .popover')).toHaveCount(0)
  await electronApp.close()
})

test('차례 팝오버 — 등록된 절만, 상태 말과 함께', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })

  await page.locator('.paper-head .chap').click()
  const pop = page.locator('.paper-head .popover')
  await expect(pop).toBeVisible()
  await expect(pop.locator('.pop-row')).toHaveCount(1)
  await expect(pop).toContainText('Ⅰ. 머리말')
  await expect(pop).toContainText('쓰는 중')
  // 가짜 차례를 만들지 않는다 — 등록되지 않은 장은 없다.
  await expect(pop).not.toContainText('Ⅶ')
  await electronApp.close()
})

test('제목줄 논문 팝오버 — 최근 논문과 새 폴더·다른 폴더 두 줄 (설계자 답 Q1)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })

  await page.locator('.titlebar .tbtn.title').click()
  const pop = page.locator('.titlebar .popover')
  await expect(pop).toBeVisible()
  await expect(pop).toContainText('최근 논문')
  // 지금 연 논문은 목록에서 빠지므로 이 장면에는 최근 줄이 없다 — 없다고 말한다.
  await expect(pop).toContainText('최근에 연 논문이 없어요')
  // 아래 두 줄. 기록 번호는 어디에도 없다(DESIGN §5).
  await expect(pop.getByRole('button', { name: '새 폴더 만들기' })).toBeVisible()
  await expect(pop.getByRole('button', { name: '다른 폴더 열기…' })).toBeVisible()
  await expect(pop).not.toContainText('번째 기록')
  await electronApp.close()
})

test('제목줄 계정 팝오버 — 두 AI 줄이 첫 실행과 같은 상태 문구를 쓴다 (설계자 답 Q2)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })

  await page.locator('.titlebar .tbtn.acct').click()
  const pop = page.locator('.titlebar .popover')
  await expect(pop).toBeVisible()
  // 첫 실행 1단계와 같은 부품(ConnectRow) — 공급자마다 한 줄.
  await expect(pop.locator('[data-provider]')).toHaveCount(2)
  await expect(pop.locator('[data-provider="codex"]')).toContainText('ChatGPT')
  await expect(pop.locator('[data-provider="claude"]')).toContainText('Claude')
  // 상태 문구가 반드시 한 줄 있다(관찰한 것만 말한다 — connectStateLine).
  for (const p of ['codex', 'claude']) {
    const line = await pop.locator(`[data-provider="${p}"] .reason`).first().innerText()
    expect(line.trim().length, `${p} 상태 문구가 비었다`).toBeGreaterThan(0)
  }
  await electronApp.close()
})

test('자료 팝오버 — 보기 전용: 현재 작성물 + 자료 전체 보기 (설계자 답 Q3)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })

  await page.locator('.paper-head').getByRole('button', { name: /자료/ }).click()
  const pop = page.locator('.paper-head .popover')
  await expect(pop).toBeVisible()
  await expect(pop).toContainText('현재 작성물')
  await expect(pop).toContainText('현재 원고')
  await expect(pop).toContainText('재무 파일')
  await expect(pop.getByRole('button', { name: '자료 전체 보기' })).toBeVisible()
  // 자료 넣기(파일 고르기)는 여기 없다 — 입력칸과 자료 시트가 맡는다.
  await expect(pop.getByRole('button', { name: '파일 고르기…' })).toHaveCount(0)
  await electronApp.close()
})
