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
import { launch, openProject, python, scripts, synthProject } from './helpers'
import { fakeCodexEnv, questionMessage, questionProject, scratch, seedChat, userDataWith } from './fixtures/fake-codex'
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
    await openProject(page, root)
    await expect(page.locator('.chat-msg.assistant').first()).toBeVisible({ timeout: 30_000 })

    // 도우미: 테두리·배경·발화자/시간 머리 없음.
    const a = page.locator('.chat-msg.assistant').first()
    expect(await a.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')
    expect(await a.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
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
    expect(await page.locator('.chat-thread').evaluate((el) => getComputedStyle(el).rowGap)).toBe('18px')
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

test('허락 카드가 쉬운 말 이유와 작은 명령을 함께 보여 준다 (N-I05)', async () => {
  const dir = scratch()
  // 가짜 서버가 command='cat /etc/hosts' + reason='논문 폴더 밖 파일을 읽으려고 해요' 를 보낸다.
  const root = questionProject()
  seedChat(root, [questionMessage()])
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_ASK: '1' })
  const { electronApp, page } = await launch({ env, userData: userDataWith(dir, { permission_mode: 'ask' }) })
  try {
    await openProject(page, root)
    const card = page.locator('.qcard')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole('radio', { name: /농협 공판장/ }).click()

    const ask = page.locator('.askcard')
    await expect(ask).toBeVisible({ timeout: 30_000 })
    await expect(ask).toContainText(CHAT.askTitle)
    // 쉬운 말 이유가 남아 있다(예전엔 command ?? reason 이 이유를 버렸다).
    await expect(ask.locator('.askcard-why')).toContainText('논문 폴더 밖 파일을 읽으려고 해요')
    // 명령은 작게.
    await expect(ask.locator('.askcard-cmd')).toContainText('cat /etc/hosts')
    expect(await ask.locator('.askcard-cmd').evaluate((el) => getComputedStyle(el).fontSize)).toBe('12.5px')
    // 상세는 접혀 있고, 펼치면 전문이 있다.
    const detail = ask.locator('details:has(summary:has-text("' + CHAT.askDetail + '"))')
    await expect(detail.locator('.prose')).toBeHidden()
    await detail.locator('summary').click()
    await expect(detail.locator('.prose')).toContainText('cat /etc/hosts')
    // 버튼은 그대로.
    await expect(ask.getByRole('button', { name: CHAT.allow, exact: true })).toBeVisible()
  } finally {
    await electronApp.close()
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
    await page.locator('.paper-head').getByRole('button', { name: /파일/ }).click()
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

test('첫 실행 두 단계 모두 폭 540 한 열 + 한 테두리 선택 묶음 (N-R01)', async () => {
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in' })
  // ① 연결 단계(고른 적 없음, 둘 다 연결됨).
  const { electronApp, page } = await launch({ userData: mkdtempSync(join(tmpdir(), 'kd-ud-')), onboarded: false, env, waitFor: 'text=먼저, 쓰고 있는 AI를 연결해요' })
  try {
    const inner = await box(page, '.onb-inner')
    expect(inner!.width).toBe(540)
    const choices = page.locator('.choices')
    await expect(choices).toHaveCount(1)
    await expect(choices.locator(':scope > .item')).toHaveCount(2)
    expect(await choices.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid')
    await expect(page.locator('.choices > .item + .item')).toHaveCount(1)
  } finally {
    await electronApp.close()
  }
  // ② 폴더 단계(연결됨 + 고른 선택) — 같은 540 열·같은 묶음.
  const second = await launch({ userData: recentUserData([synthProject()]), env, waitFor: 'text=논문을 담을 폴더를 골라요' })
  try {
    expect((await box(second.page, '.onb-inner'))!.width).toBe(540)
    await expect(second.page.locator('.choices > .item')).toHaveCount(2)
    await expect(second.page.locator('.choices > .item + .item')).toHaveCount(1)
  } finally {
    await second.electronApp.close()
  }
})

test('최근 논문은 한 줄 목록 — 이름 + 시점, 기록 번호 칩 없음 (N-R02)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const roots = [synthProject(), synthProject(), synthProject()]
  const { electronApp, page } = await launch({ userData: recentUserData(roots), env, waitFor: 'text=논문을 담을 폴더를 골라요' })
  try {
    const list = page.locator('.projects')
    await expect(list.locator('.project')).toHaveCount(3)
    expect(await list.evaluate((el) => getComputedStyle(el).flexDirection)).toBe('column')
    // 기록 번호 칩이 없다 — 카드가 아니라 한 줄이다.
    await expect(page.locator('.project .badge')).toHaveCount(0)
    const one = page.locator('.project').first()
    await expect(one.locator('.m').first()).toBeVisible()
    await expect(one.getByRole('button', { name: '목록에서 제거' })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('입력칸 칩은 지금 AI + 생각 깊이(표시만)를 열고 깊이는 비활성 (I-02 ①)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const chip = page.locator('.chat-composer .crow .model')
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await expect(chip).toContainText('ChatGPT')
    await expect(chip).toContainText(CHAT.depthChip)
    await expect(chip).toHaveAttribute('title', CHAT.modelChipTitle)

    await chip.click()
    const pop = page.locator('.chat-composer .popover')
    await expect(pop).toBeVisible()
    // 위: AI 바꾸기(제목줄 계정 팝오버와 같은 부품).
    await expect(pop.locator('[data-provider]')).toHaveCount(2)
    // 아래: 생각 깊이 — 흐린 비활성 줄, 값은 지어내지 않는다.
    const depth = pop.locator('.pop-row.off')
    await expect(depth).toContainText(CHAT.depthDefault)
    await expect(depth).toContainText(CHAT.depthSoon)
    await expect(depth).toHaveAttribute('aria-disabled', 'true')
    // 모델 이름을 지어내지 않는다.
    await expect(pop).not.toContainText(/GPT-\d|Sol|깊게/)
  } finally {
    await electronApp.close()
  }
})

test('설치 안내 상자는 점선 카드가 아니라 아이스 그레이 상자 (책임자 추가)', async () => {
  // 도구가 없는 세계 — 대화 아래 칸에 설치 안내가 뜬다.
  const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
  const root = synthProject()
  const { electronApp, page } = await launch({ env: { KNUAF_AGENT_PATH_ONLY: '1', PATH: '', HOME: home } })
  try {
    await openProject(page, root)
    const note = page.locator('.chat-zone .zone-note')
    await expect(note).toBeVisible({ timeout: 30_000 })
    await expect(note).toContainText('도우미 프로그램이 아직 설치되지 않았어요')
    expect(await note.evaluate((el) => getComputedStyle(el).borderTopStyle), '점선 카드가 남아 있다').toBe('solid')
    const { got, want } = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.background = 'var(--alert-bg)'
      document.body.appendChild(probe)
      const want = getComputedStyle(probe).backgroundColor
      probe.remove()
      const el = document.querySelector('.chat-zone .zone-note') as HTMLElement
      return { got: getComputedStyle(el).backgroundColor, want }
    })
    expect(got).toBe(want)
    // 버튼 동작은 그대로.
    await expect(note.getByRole('button', { name: '설치 안내' })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

// 첫 실행 폴더 단계에서 최근 카드가 실제로 열리는지(선택자 `.project` 보존) — 기존 시험이 이미
// 덮는다(settings/onboarding). 여기서는 상태만 확인한다.
test('연결이 끊긴 재실행은 1단계(AI 연결)부터 (N-R03 확인)', async () => {
  const root = synthProject()
  const userData = recentUserData([root])
  const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
  const { electronApp, page } = await launch({ userData, env: { KNUAF_AGENT_PATH_ONLY: '1', PATH: '', HOME: home } })
  try {
    // 저장된 선택(codex)이 이 환경에서 확인되지 않으므로 폴더 단계로 넘어가지 못한다.
    await expect(page.locator('text=연결 도구(Codex)를 먼저 설치해요')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('text=논문을 담을 폴더를 골라요')).toHaveCount(0)
    expect(existsSync(join(userData, 'settings.json'))).toBe(true)
  } finally {
    await electronApp.close()
  }
})
