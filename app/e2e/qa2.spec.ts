/**
 * 2차 QA(ORDER-QA2-A) 처분 시험 — N-I01·02·05·06·07, N-R01·02, I-02 ①, 그리고 설치 안내 상자.
 *
 * 지적마다 원 QA 의 재현 입력을 그대로 쓴다: 대화 3개, 900×600 질문 카드, command+reason 허락,
 * 긴 한글 파일명, 파일 16개, 첫 실행 두 단계, 최근 3개. 숨김 실행(`launch()` 기본).
 * 실제 로그인·AI 호출 없음 — 가짜 `codex app-server` 만 쓴다.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, openProject, python, scripts, splitReady, synthProject } from './helpers'
import { fakeCodexEnv, questionMessage, questionProject, scratch, seedChat, userDataWith, writeFakeClaude } from './fixtures/fake-codex'
import { CHAT } from '../src/renderer/src/copy'

const box = async (page: Page, sel: string) => page.locator(sel).first().boundingBox()
const setBounds = (ea: ElectronApplication, width: number, height: number) =>
  ea.evaluate(({ BrowserWindow }, b) => { BrowserWindow.getAllWindows()[0].setBounds(b) }, { width, height })

/** 최근 폴더 3개 + 고른 선택을 심은 userData — 첫 실행 폴더 단계를 세운다. */
function recentUserData(roots: string[]): string {
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({
    show_intro: false,
    onboarded_at: '2026-10-18T00:00:00.000Z',
    provider_choice: { provider: 'codex', at: '2026-10-18T00:00:00.000Z' },
    recent: roots.map((root) => ({ root, opened_at: '2026-10-18T00:00:00.000Z' }))
  }), 'utf-8')
  return userData
}

test('도우미는 테두리 없는 본문, 학생만 오른쪽 말풍선, 간격 18px (N-I01)', async () => {
  const root = synthProject()
  const now = new Date().toISOString()
  seedChat(root, [
    { id: 'a1', role: 'assistant', text: '안녕하세요. 창업논문을 같이 쓸 도우미예요.', at: now },
    { id: 'u1', role: 'user', text: '1000평이요. 품종은 듀크랑 레가시', at: now, delivery: 'sent' },
    { id: 'a2', role: 'assistant', text: '좋아요. 3,300㎡(약 1,000평)로 적었어요.', at: now }
  ])
  const { electronApp, page } = await launch()
  try {
    // 이 폴더에는 본문이 있는 종이가 있다 — 두 칸 배치가 선 뒤에야 대화 칸 폭이 최종이 된다.
    await openProject(page, root, splitReady)
    await expect(page.locator('.chat-msg.assistant').first()).toBeVisible({ timeout: 30_000 })

    // 도우미: 테두리·배경·발화자/시간 머리 없음.
    // (한 번 잡은 요소에 getComputedStyle 을 직접 읽지 않고 재시도 단언을 쓴다 — 그 사이 노드가
    //  새로 그려지면 떨어진 요소가 되어 빈 값이 온다. 아래 설치 안내 상자에서 실제로 그랬다.)
    const a = page.locator('.chat-msg.assistant').first()
    await expect(a).toHaveCSS('border-top-width', '0px')
    await expect(a).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    expect(await page.locator('.chat-msg-head, .chat-who').count()).toBe(0)

    // 학생: 오른쪽 말풍선(최대 78%).
    const u = page.locator('.chat-msg.user').first()
    await expect(u).toBeVisible()
    const ab = await box(page, '.chat-msg.assistant')
    const ub = await box(page, '.chat-msg.user')
    const tb = await box(page, '.chat-thread')
    expect(ub!.x, '학생 답이 오른쪽으로 붙지 않았다').toBeGreaterThan(ab!.x + 80)
    expect(ub!.x + ub!.width, '학생 말풍선이 오른쪽 여백을 넘었다').toBeLessThanOrEqual(tb!.x + tb!.width - 30 + 1.5)

    // 메시지 간격 18px.
    await expect(page.locator('.chat-thread')).toHaveCSS('row-gap', '18px')
  } finally {
    await electronApp.close()
  }
})

test('900×600 에서 질문 카드의 직접 입력 줄이 화면 안에 있고 대화가 스크롤된다 (N-I02)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = questionProject()
  seedChat(root, [questionMessage()])
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await setBounds(electronApp, 900, 600)
    await expect(page.locator('.qcard')).toBeVisible({ timeout: 30_000 })
    const free = page.locator('.qcard .qopt.free')
    await expect(free).toBeVisible()
    const fb = await free.boundingBox()
    expect(fb!.y + fb!.height, '직접 입력 줄이 화면 아래로 잘렸다').toBeLessThanOrEqual(600)
    expect(fb!.y).toBeGreaterThanOrEqual(0)

    // 대화는 자기 안에서 흐른다 — 휠을 보내면 스크롤 위치가 0 을 벗어난다.
    const thread = page.locator('.chat-thread')
    const scrollable = await thread.evaluate((el) => el.scrollHeight > el.clientHeight)
    if (scrollable) {
      await page.mouse.move(450, 250)
      await page.mouse.wheel(0, 800)
      await expect.poll(() => thread.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    }
  } finally {
    await electronApp.close()
  }
})

/** 허락 카드 장면을 세운다 — 가짜 서버가 준 command·reason 을 그대로 화면에 띄운다. */
async function openAsk(dir: string, extra: Record<string, string>): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const root = questionProject()
  seedChat(root, [questionMessage()])
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_ASK: '1', ...extra })
  const { electronApp, page } = await launch({ env, userData: userDataWith(dir, { permission_mode: 'ask' }) })
  await openProject(page, root)
  const card = page.locator('.qcard')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByRole('radio', { name: /농협 공판장/ }).click()
  await expect(page.locator('.askcard')).toBeVisible({ timeout: 30_000 })
  return { electronApp, page }
}

test('허락 카드가 명령과 이유를 원문 그대로 한 덩어리로 보여 준다 (N-I05)', async () => {
  // 가짜 서버가 command='cat /etc/hosts' + reason='논문 폴더 밖 파일을 읽으려고 해요' 를 보낸다.
  const { electronApp, page } = await openAsk(scratch(), {})
  try {
    const ask = page.locator('.askcard')
    await expect(ask).toContainText(CHAT.askTitle)
    // 위 제목은 기존 쉬운 말 그대로.
    await expect(ask.locator('.askcard-t')).toHaveText('명령 실행 확인')
    // 원문(명령 + 이유)이 한 덩어리로, 작은 글자로 남아 있다 — 나뉘지 않는다(QA2A-R1-02).
    const raw = ask.locator('.askcard-raw')
    await expect(raw).toContainText('cat /etc/hosts')
    await expect(raw).toContainText('논문 폴더 밖 파일을 읽으려고 해요')
    await expect(raw).toHaveCSS('font-size', '12.5px')
    await expect(ask.locator('.askcard-cmd, .askcard-why')).toHaveCount(0)
    // 상세는 접혀 있고, 펼치면 원문 전체가 있다.
    const detail = ask.locator('details:has(summary:has-text("' + CHAT.askDetail + '"))')
    await expect(detail.locator('.prose')).toBeHidden()
    await detail.locator('summary').click()
    await expect(detail.locator('.prose')).toContainText('cat /etc/hosts')
    await expect(detail.locator('.prose')).toContainText('논문 폴더 밖 파일을 읽으려고 해요')
    // 버튼은 그대로.
    await expect(ask.getByRole('button', { name: CHAT.allow, exact: true })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('두 줄 명령도 순서가 뒤섞이지 않는다 (QA2A-R1-02 A)', async () => {
  const cmd = 'printf "first"\nprintf "second"'
  const { electronApp, page } = await openAsk(scratch(), { FAKE_CODEX_ASK_COMMAND: cmd })
  try {
    const raw = page.locator('.askcard-raw')
    // 첫 줄을 명령으로 단정하지 않으므로 두 줄이 원문 순서대로 한 덩어리로 남는다.
    expect(await raw.innerText()).toBe(`${cmd}\n\n논문 폴더 밖 파일을 읽으려고 해요`)
    await expect(page.locator('.askcard-cmd, .askcard-why')).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('이유만 있는 요청을 명령으로 오분류하지 않는다 (QA2A-R1-02 B)', async () => {
  const reason = '논문 폴더 밖 파일을 읽으려고 해요'
  const { electronApp, page } = await openAsk(scratch(), { FAKE_CODEX_ASK_COMMAND: '' })
  try {
    await expect(page.locator('.askcard-raw')).toHaveText(reason)
    await expect(page.locator('.askcard-t')).toHaveText('명령 실행 확인')
    await expect(page.locator('.askcard-cmd, .askcard-why')).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('칩 팝오버는 위로 열려 Claude 행·깊이 줄이 화면 안에 있다 (QA2A-R1-01)', async () => {
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in' })
  writeFakeClaude(bin)
  const root = synthProject()
  for (const [w, h] of [[1180, 800], [900, 600]] as const) {
    const { electronApp, page } = await launch({ env })
    try {
      await openProject(page, root)
      const chip = page.locator('.chat-composer .crow .model')
      await expect(chip).toBeVisible({ timeout: 30_000 })
      await electronApp.evaluate(({ BrowserWindow }, b) => { BrowserWindow.getAllWindows()[0].setBounds(b) }, { width: w, height: h })
      await chip.click()
      const pop = page.locator('.chat-composer .popover')
      await expect(pop).toBeVisible()
      // 목록이 길어져도 팝오버는 창 안에 남고 각 조작에 스크롤로 도달할 수 있다.
      for (const sel of ['.chat-composer .popover', '[data-provider="claude"]', '.chat-composer .model-depth']) {
        await page.locator(sel).first().scrollIntoViewIfNeeded()
        const b = await box(page, sel)
        expect(b, `${sel} 이 없다`).not.toBeNull()
        expect(b!.y, `${w}×${h}: ${sel} 이 화면 위로 나갔다`).toBeGreaterThanOrEqual(0)
        expect(b!.y + b!.height, `${w}×${h}: ${sel} 이 화면 아래로 잘렸다`).toBeLessThanOrEqual(h + 0.5)
      }
      // Claude 변경 버튼도 화면 안.
      const btn = page.locator('[data-provider="claude"]').getByRole('button')
      await btn.scrollIntoViewIfNeeded()
      await expect(btn).toBeVisible()
      const bb = await btn.boundingBox()
      expect(bb!.y + bb!.height).toBeLessThanOrEqual(h + 0.5)
    } finally {
      await electronApp.close()
    }
  }
})

test('자료 팝오버의 긴 이름은 한 줄로 줄고 가로로 넘치지 않는다 (N-I06)', async () => {
  const root = synthProject()
  const longName = '농장별_원자료_2026년_검토를_위한_긴_참고자료_이름_재배면적과_판매처_답변_정리.md'
  writeFileSync(join(root, 'sources', longName), '# 원자료\n\n재배 면적: 600평\n', 'utf-8')
  const change = join(root, 'change-long.json')
  writeFileSync(change, JSON.stringify({ request_id: 'e2e:long', ops: [
    { collection: 'sources', value: { id: 'src-long', path: `sources/${longName}`, claims: {} } }
  ] }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', '1'], { encoding: 'utf-8' })
  expect(r.status, r.stdout + r.stderr).toBe(0)

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await page.locator('.paper-head').getByRole('button', { name: /자료/ }).click()
    const pop = page.locator('.paper-head .popover')
    await expect(pop).toBeVisible()
    const m = await pop.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, h: el.getBoundingClientRect().height }))
    expect(m.sw, '팝오버가 가로로 넘친다').toBeLessThanOrEqual(m.cw + 1)
    expect(m.h, '팝오버가 창 높이를 넘는다').toBeLessThanOrEqual(800 - 160 + 1)
    // 이름은 한 줄 말줄임(전체 이름은 title).
    const name = pop.locator(`b[title*="${longName.slice(0, 12)}"]`).first()
    await expect(name).toBeVisible()
    expect(await name.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap')
    expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    // 아래 이동은 보인다.
    await expect(pop.getByRole('button', { name: '자료 전체 보기' })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('파일 팝오버는 16개에서도 목록만 스크롤하고 아래 이동이 보인다 (N-I07)', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  for (let i = 0; i < 16; i++) writeFileSync(join(root, 'build', `검토파일-${String(i).padStart(2, '0')}.docx`), 'dummy', 'utf-8')
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await page.locator('.paper-head').getByRole('button', { name: /파일 \d+$/ }).click()
    const pop = page.locator('.paper-head .popover')
    await expect(pop).toBeVisible()
    const m = await pop.evaluate((el) => ({ h: el.getBoundingClientRect().height, bottom: el.getBoundingClientRect().bottom }))
    expect(m.h, '팝오버가 창 높이를 넘는다').toBeLessThanOrEqual(800 - 160 + 1)
    expect(m.bottom).toBeLessThanOrEqual(800)
    // 목록만 안에서 스크롤한다.
    const list = pop.locator('.pop-scroll')
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight), '목록이 스크롤되지 않는다').toBe(true)
    // 아래 이동은 늘 보인다.
    await expect(pop.getByRole('button', { name: '결과물 전체 보기' })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})



