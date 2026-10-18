/**
 * 검토 P3-R1 처분 시험 — 새 만들기 진입점의 고지·진행·결과(P3-R1-01), 프로젝트 기준 경로
 * (P3-R1-02), 파일별 검토본 기준(P3-R1-03), 늦게 생긴 입력 조건(P3-R1-05), 점검 시트의
 * 현재성(P3-R1-06).
 *
 * 전부 숨김 실행이다(`launch()` 가 `KNUAF_E2E_HIDDEN=1` 을 켠다).
 */
import { expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, navTo, openProject, python, rewriteSection, scripts, synthProject } from './helpers'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'

/** `shell:open` 이 받은 값을 메모리에만 적어 둔다(문서 앱을 실제로 열지 않는다). */
async function captureOpenPath(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }) => {
    type G = { __openedPath?: string }
    ipcMain.removeHandler('shell:open')
    ipcMain.handle('shell:open', (_e: unknown, p: string) => { (globalThis as G).__openedPath = p; return '' })
  })
}

async function openedPath(electronApp: ElectronApplication): Promise<string | undefined> {
  return electronApp.evaluate(() => (globalThis as { __openedPath?: string }).__openedPath)
}

/** 앱의 "새로고침" 메뉴 동작을 그대로 보낸다(네이티브 메뉴는 클릭할 수 없다). */
async function triggerRefresh(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.send('menu', { type: 'refresh' }) })
}

/** `build/<N>/review/검토용.md` 를 CLI 로 만든다. */
function exportReview(root: string): void {
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'export', root, '--kind', 'review'], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

test('팝오버의 만들기 고지·결과가 그 줄 아래에 남는다 (P3-R1-01)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()   // 독립검토 기록 없음 → 고지 대상
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await page.locator('.paper-head').getByRole('button', { name: /파일/ }).click()
    const pop = page.locator('.paper-head .popover')
    const reviewRow = pop.locator('.pop-make:has(b:text-is("검토본 만들기"))')
    await reviewRow.getByRole('button').click()

    // 시도 전후 모두 고지가 그 줄 아래에 있다.
    const fb = pop.locator('[data-make="review"] .make-fb')
    await expect(fb.first(), '독립검토 미실행 고지가 만들기 줄에 없다').toContainText('독립검토', { timeout: 10_000 })
    // 결과도 같은 자리에서 이어진다(경로 + 폴더에서 보기).
    await expect(pop).toContainText('검토본을 만들었어요', { timeout: 60_000 })
    await expect(pop.getByRole('button', { name: '폴더에서 보기' }).first()).toBeVisible()

    // 제출용 후보 — 관문이 막혀 있으면 그 이유가 같은 자리에 보인다.
    const submitRow = pop.locator('.pop-make:has(b:text-is("제출용 파일 만들기"))')
    await submitRow.getByRole('button').click()
    await expect(pop).toContainText('제출용 파일', { timeout: 30_000 })
    await expect(pop.locator('.make-fb.warning').last()).toBeVisible({ timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})

test('팝오버를 닫아도 결과가 종이 머리 아래 한 줄로 이어진다 (P3-R1-01)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await page.locator('.paper-head').getByRole('button', { name: /파일/ }).click()
    const pop = page.locator('.paper-head .popover')
    await pop.locator('.pop-make:has(b:text-is("검토본 만들기"))').getByRole('button').click()
    await expect(pop).toContainText('검토본을 만들었어요', { timeout: 60_000 })

    // 팝오버를 닫으면 종이 머리 아래 한 줄로 같은 결과가 남는다.
    await page.keyboard.press('Escape')
    await expect(page.locator('.paperpane .popover')).toHaveCount(0)
    await expect(page.locator('.paper-fb')).toContainText('검토본을 만들었어요')

    // 결과물 전체 보기에서도 같은 실행의 결과가 이어진다(같은 훅 상태).
    await page.locator('.paper-head').getByRole('button', { name: /파일/ }).click()
    await page.getByRole('button', { name: '결과물 전체 보기' }).click()
    const sheet = page.locator('[data-screen="artifacts"]')
    await expect(sheet).toContainText('검토본을 만들었어요')
  } finally {
    await electronApp.close()
  }
})

test('점검에서 파일을 열 때 프로젝트 기준 경로를 넘긴다 (P3-R1-02)', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', 'probe.docx'), 'dummy')
  const { electronApp, page } = await launch()
  try {
    await captureOpenPath(electronApp)
    await openProject(page, root)
    await navTo(page, '점검')
    const sheet = page.locator('[data-screen="checkup"]')
    await expect(sheet).toContainText('probe.docx', { timeout: 30_000 })
    await sheet.locator('.file').filter({ hasText: 'probe.docx' }).getByRole('button').last().click()
    await expect.poll(() => openedPath(electronApp)).toBe(join(root, 'build', 'probe.docx'))
  } finally {
    await electronApp.close()
  }
})

test('검토본 줄은 각자 자기 기록 기준으로 말한다 (P3-R1-03)', async () => {
  const root = synthProject()
  exportReview(root)                                       // build/1/review/검토용.md
  rewriteSection(root, { body: '고친 본문이다.', expected: 1 })   // revision 2
  exportReview(root)                                       // build/2/review/검토용.md
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await page.locator('.paper-head').getByRole('button', { name: /파일/ }).click()
    const pop = page.locator('.paper-head .popover')
    // 두 줄이 서로 다른 기준을 말한다 — 최신 N 을 둘 다에 붙이면 여기서 걸린다.
    await expect(pop).toContainText('2번째 기록 기준')
    await expect(pop).toContainText('1번째 기록 기준')
  } finally {
    await electronApp.close()
  }
})

test('나중에 생긴 표지 입력을 새로고침이 알아챈다 (P3-R1-05)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await page.locator('.paper-head').getByRole('button', { name: /파일/ }).click()
    const pop = page.locator('.paper-head .popover')
    const docxRow = pop.locator('.pop-make:has(b:text-is("논문 DOCX 만들기"))')
    await expect(docxRow.getByRole('button'), '표지 입력도 본문도 없으면 잠겨 있는 것이 맞다').toBeDisabled()

    // 도우미가 표지 입력을 준비했다 — 기록은 그대로이므로 새로고침이 그것을 봐야 한다.
    writeFileSync(join(root, 'paper-input.json'), JSON.stringify({ title: '시험 논문' }), 'utf-8')
    await triggerRefresh(electronApp)
    await expect(docxRow.getByRole('button'), '새로고침 뒤에도 입력을 못 본다').toBeEnabled({ timeout: 20_000 })

    // 결과물 전체 화면도 같은 조건을 본다.
    await page.getByRole('button', { name: '결과물 전체 보기' }).click()
    const sheet = page.locator('[data-screen="artifacts"]')
    await expect(sheet.locator('.make-row:has-text("논문 DOCX 만들기") button')).toBeEnabled({ timeout: 20_000 })
  } finally {
    await electronApp.close()
  }
})

test('점검 시트도 파일 팝오버와 같은 현재성을 말한다 (P3-R1-06)', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', 'known.docx'), 'dummy')
  // 정본에 등록 산출물을 **직접** 심는다(검토자 재현과 같은 방식). gg apply 는 출력 계보
  // 검증(입력 버전·대상 일치)을 걸어서, 손으로 만든 항목은 거기서 거부된다.
  const projPath = join(root, 'project.json')
  const proj = JSON.parse(readFileSync(projPath, 'utf-8')) as { outputs?: Record<string, unknown> }
  proj.outputs = { ...(proj.outputs ?? {}), 'probe-docx': { id: 'probe-docx', path: 'build/known.docx', format: 'docx', revision: 1, stale: true } }
  writeFileSync(projPath, JSON.stringify(proj, null, 2), 'utf-8')
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await navTo(page, '점검')
    const sheet = page.locator('[data-screen="checkup"]')
    // 팝오버와 같은 판정 — 등록된 파일은 stale 이면 그렇게 말한다('모름'이 아니다).
    await expect(sheet.locator('.file').filter({ hasText: 'known.docx' })).toContainText('고친 내용이 빠져 있어요', { timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})

test('파일 현재성 문구는 근거 없는 파일에만 "모름"을 남긴다 (P3-R1-06)', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', 'unknown.docx'), 'dummy')
  expect(existsSync(join(root, 'build', 'unknown.docx'))).toBe(true)
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await page.locator('.paper-head').getByRole('button', { name: /파일/ }).click()
    await expect(page.locator('.paper-head .popover .pop-row').filter({ hasText: 'unknown.docx' })).toContainText('앱이 몰라요')
  } finally {
    await electronApp.close()
  }
})
