/**
 * 단계 3-B 캡처 — 밝게·어둡게 × 1280 · 1024 · 900.
 *
 * `docs/images`(학생용 안내 그림)에는 쓰지 않는다. 경로는 발주가 지정한 `impl/shots-p3/` 다.
 * 세로 창(900)은 "바꾸기"의 두 얼굴(대화·내 논문)을 같이 남긴다.
 *
 * 캡처는 **정착한 화면**을 찍는다: 첫 열림 전이(500ms)가 끝나기를 기다린 뒤 찍는다.
 */
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, openProject, setWindowWidth, synthProject } from './helpers'
import { mkdirSync as mkdir, readFileSync, writeFileSync } from 'node:fs'

const OUT = process.env.KNUAF_SHOT_DIR ?? resolve(__dirname, '..', 'test-results', 'p3-shots')

async function shoot(page: import('@playwright/test').Page, name: string): Promise<void> {
  // **정착한 화면**을 찍는다 — 대화 칸은 스냅샷·연결 상태가 도착해야 그려지고, 그 전에는
  // 빈 칸에 "연결 확인 중…"만 남는다(캡처가 그 순간을 잡으면 화면이 없다).
  await page.waitForSelector('.chat-empty, .chat-msg, .qcard', { timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/${name}.png` })
}

for (const scheme of ['light', 'dark'] as const) {
  test(`captures — ${scheme} · 1280`, async () => {
    mkdirSync(OUT, { recursive: true })
    // 한 칸: 아직 쓴 글이 없는 폴더.
    const fresh = synthProject({ withContent: false })
    const first = await launch({ colorScheme: scheme })
    await openProject(first.page, fresh)
    await shoot(first.page, `solo-1280-${scheme}`)
    await first.electronApp.close()

    // 두 칸 + 팝오버 + 만들기 피드백 + 점검 시트.
    const root = synthProject()
    // 점검 시트의 현재성(R1-06)이 실제로 보이게 등록 산출물 하나를 심는다.
    mkdir(join(root, 'build'), { recursive: true })
    writeFileSync(join(root, 'build', '검토전_논문.docx'), 'dummy')
    const projPath = join(root, 'project.json')
    const proj = JSON.parse(readFileSync(projPath, 'utf-8')) as { outputs?: Record<string, unknown> }
    proj.outputs = { ...(proj.outputs ?? {}), 'probe-docx': { id: 'probe-docx', path: 'build/검토전_논문.docx', format: 'docx', revision: 1, stale: true } }
    writeFileSync(projPath, JSON.stringify(proj, null, 2), 'utf-8')
    const { electronApp, page } = await launch({ colorScheme: scheme })
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await shoot(page, `split-1280-${scheme}`)

    await page.locator('.paper-head').getByRole('button', { name: /파일/ }).click()
    await shoot(page, `files-popover-1280-${scheme}`)
    // 팝오버에서 바로 만들고, 고지·결과가 그 줄 아래에 남은 모습(R1-01).
    await page.locator('.paper-head .popover .pop-make:has(b:text-is("검토본 만들기"))').getByRole('button').click()
    await expect(page.locator('.paper-head .popover')).toContainText('검토본을 만들었어요', { timeout: 60_000 })
    await shoot(page, `make-feedback-1280-${scheme}`)
    await page.keyboard.press('Escape')

    // 점검은 정식 진입점(제목줄 "지금 ▾" → 전체 과정 → 제출 점검·마무리)으로 연다.
    await page.locator('.titlebar .tbtn.now').click()
    await page.locator('.titlebar .popover').getByRole('button', { name: /제출 점검·마무리/ }).click()
    await shoot(page, `checkup-sheet-1280-${scheme}`)
    await electronApp.close()
  })

  test(`captures — ${scheme} · 1024`, async () => {
    mkdirSync(OUT, { recursive: true })
    // 1,024 < 1,140 이라 두 칸이 안 들어간다 — 여기서도 좁은 창(바꾸기)이다.
    const root = synthProject()
    const { electronApp, page } = await launch({ colorScheme: scheme })
    await openProject(page, root)
    await setWindowWidth(electronApp, 1024)
    await expect(page.locator('.tbar-seg')).toBeVisible({ timeout: 20_000 })
    await shoot(page, `switch-chat-1024-${scheme}`)
    await page.locator('.tbar-seg').getByRole('tab', { name: '내 논문' }).click()
    await expect(page.locator('.paperpane')).toBeVisible()
    await shoot(page, `switch-paper-1024-${scheme}`)
    await electronApp.close()
  })

  test(`captures — ${scheme} · 900`, async () => {
    mkdirSync(OUT, { recursive: true })
    const root = synthProject()
    const { electronApp, page } = await launch({ colorScheme: scheme })
    await openProject(page, root)
    await setWindowWidth(electronApp, 900)
    await expect(page.locator('.tbar-seg')).toBeVisible({ timeout: 20_000 })
    await shoot(page, `switch-chat-900-${scheme}`)
    await page.locator('.tbar-seg').getByRole('tab', { name: '내 논문' }).click()
    await expect(page.locator('.paperpane')).toBeVisible()
    await shoot(page, `switch-paper-900-${scheme}`)
    await electronApp.close()
  })
}
