/**
 * 2차 QA 수정 A — 캡처 생성기(발주: `impl/shots-qa2/` 밝게·어둡게).
 *
 * 찍는 자리(발주): 대화 3개 · 900×600 질문 카드 · 허락 카드 · 자료 긴 이름 · 파일 16개 ·
 * 첫 실행 두 단계 · 최근 3개 · I-02 칩·팝오버. `KNUAF_QA2_SHOTS=1` 일 때만 돈다.
 * 실행: `KNUAF_QA2_SHOTS=1 pnpm -C app exec playwright test e2e/qa2-shots.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, openProject, python, scripts, synthProject } from './helpers'
import { fakeCodexEnv, questionMessage, questionProject, scratch, seedChat, userDataWith, writeFakeClaude } from './fixtures/fake-codex'

const OUT = process.env.KNUAF_QA2_SHOTS_DIR ?? resolve('/Users/nara/knuaf-dev/docs/design/gui-2026-10-opus-v5/impl/shots-qa2')
test.skip(process.env.KNUAF_QA2_SHOTS !== '1' || !existsSync(resolve(OUT, '..')), 'KNUAF_QA2_SHOTS=1 이고 대상 폴더가 있을 때만')

async function settled(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(
    document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))
  ))
}
function recentUserData(roots: string[]): string {
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({
    show_intro: false, onboarded_at: '2026-10-18T00:00:00.000Z',
    provider_choice: { provider: 'codex', at: '2026-10-18T00:00:00.000Z' },
    recent: roots.map((root) => ({ root, opened_at: '2026-10-18T00:00:00.000Z' }))
  }), 'utf-8')
  return userData
}

for (const scheme of ['light', 'dark'] as const) {
  test(`QA2 캡처 (${scheme})`, async () => {
    test.setTimeout(240_000)
    mkdirSync(OUT, { recursive: true })
    const dir = scratch()
    const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_ASK: '1' })
    const shot = async (page: Page, name: string): Promise<void> => {
      await settled(page)
      const file = join(OUT, `${name}-${scheme}.png`)
      await page.screenshot({ path: file })
      console.log('captured', file, statSync(file).size, 'bytes')
    }

    // --- 첫 실행 두 단계 ---
    const binBoth = join(dir, 'bin2')
    const envBoth = fakeCodexEnv(binBoth, { FAKE_CODEX_MODE: 'logged-in' })
    writeFakeClaude(binBoth)
    const step1 = await launch({ userData: mkdtempSync(join(tmpdir(), 'kd-ud-')), onboarded: false, colorScheme: scheme, env: envBoth, waitFor: 'text=먼저, 쓰고 있는 AI를 연결해요' })
    try { await step1.page.setViewportSize({ width: 1280, height: 800 }); await shot(step1.page, '06-step1-connect') } finally { await step1.electronApp.close() }
    const step2 = await launch({ userData: recentUserData([synthProject(), synthProject(), synthProject()]), colorScheme: scheme, env: envBoth, waitFor: 'text=논문을 담을 폴더를 골라요' })
    try { await step2.page.setViewportSize({ width: 1280, height: 800 }); await shot(step2.page, '07-step2-folder-recent3') } finally { await step2.electronApp.close() }

    // --- 대화 3개 + 입력칸 칩(질문 없음 → 입력칸이 선다) ---
    const chatRoot = synthProject()
    const now = new Date().toISOString()
    seedChat(chatRoot, [
      { id: 'a1', role: 'assistant', text: '안녕하세요. 창업논문을 같이 쓸 도우미예요.', at: now },
      { id: 'u1', role: 'user', text: '1000평이요. 품종은 듀크랑 레가시', at: now, delivery: 'sent' },
      { id: 'a2', role: 'assistant', text: '좋아요. 3,300㎡(약 1,000평)로 적었어요.', at: now }
    ])
    const chat = await launch({ colorScheme: scheme, env })
    try {
      await chat.page.setViewportSize({ width: 1280, height: 800 })
      await openProject(chat.page, chatRoot)
      await expect(chat.page.locator('.chat-composer')).toBeVisible({ timeout: 30_000 })
      await shot(chat.page, '01-chat-three')
      // I-02 칩 + 팝오버
      await chat.page.locator('.chat-composer .crow .model').click()
      await shot(chat.page, '08-chip-popover')
      await chat.page.keyboard.press('Escape')
    } finally {
      await chat.electronApp.close()
    }

    // --- 900×600 질문 카드 · 허락 카드 (질문이 있는 폴더) ---
    const root = questionProject()
    seedChat(root, [questionMessage()])

    // --- 900×600 질문 카드 ---
    const q900 = await launch({ colorScheme: scheme, env })
    try {
      await openProject(q900.page, root)
      await q900.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setBounds({ width: 900, height: 600 }) })
      await expect(q900.page.locator('.qcard')).toBeVisible({ timeout: 30_000 })
      await shot(q900.page, '02-question-900x600')
    } finally {
      await q900.electronApp.close()
    }

    // --- 허락 카드 ---
    const perm = await launch({ colorScheme: scheme, env, userData: userDataWith(dir, { permission_mode: 'ask' }) })
    try {
      await perm.page.setViewportSize({ width: 1280, height: 800 })
      await openProject(perm.page, root)
      const card = perm.page.locator('.qcard')
      await expect(card).toBeVisible({ timeout: 30_000 })
      await card.getByRole('radio', { name: /농협 공판장/ }).click()
      await expect(perm.page.locator('.askcard')).toBeVisible({ timeout: 30_000 })
      await shot(perm.page, '03-permission')
    } finally {
      await perm.electronApp.close()
    }

    // --- 자료 긴 이름 ---
    const mroot = synthProject()
    const longName = '농장별_원자료_2026년_검토를_위한_긴_참고자료_이름_재배면적과_판매처_답변_정리.md'
    writeFileSync(join(mroot, 'sources', longName), '# 원자료\n', 'utf-8')
    const chg = join(mroot, 'change-long.json')
    writeFileSync(chg, JSON.stringify({ request_id: 'e2e:long', ops: [{ collection: 'sources', value: { id: 'src-long', path: `sources/${longName}`, claims: {} } }] }), 'utf-8')
    spawnSync(python, [join(scripts, 'gg.py'), 'apply', mroot, '--change', chg, '--expected-revision', '1'], { encoding: 'utf-8' })
    const mats = await launch({ colorScheme: scheme, env })
    try {
      await mats.page.setViewportSize({ width: 1280, height: 800 })
      await openProject(mats.page, mroot)
      await expect(mats.page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
      await mats.page.locator('.paper-head').getByRole('button', { name: /자료/ }).click()
      await shot(mats.page, '04-materials-long')
    } finally {
      await mats.electronApp.close()
    }

    // --- 파일 16개 ---
    const froot = synthProject()
    mkdirSync(join(froot, 'build'), { recursive: true })
    for (let i = 0; i < 16; i++) writeFileSync(join(froot, 'build', `검토파일-${String(i).padStart(2, '0')}.docx`), 'dummy', 'utf-8')
    const files = await launch({ colorScheme: scheme, env })
    try {
      await files.page.setViewportSize({ width: 1280, height: 800 })
      await openProject(files.page, froot)
      await expect(files.page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
      await files.page.locator('.paper-head').getByRole('button', { name: /파일/ }).click()
      await shot(files.page, '05-files-many')
    } finally {
      await files.electronApp.close()
    }
  })
}
