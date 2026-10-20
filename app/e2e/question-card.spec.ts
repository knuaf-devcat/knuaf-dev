/**
 * 아래 칸 e2e — 질문 카드가 입력칸을 덮고, 직접 입력·숫자 키·잠금·허락·작업 중이
 * 설계대로 움직이는지 실제 Electron 앱으로 밟는다.
 *
 * 도우미는 가짜 `codex app-server`(fixtures/fake-codex-server.mjs)로 띄운다 — 경로 앞자리에
 * 두므로 실제 codex 가 깔린 기계와 CI 가 같은 장면을 본다.
 */
import { expect, test } from '@playwright/test'
import { launch, openProject, PROGRESS } from './helpers'
import { CHAT } from '../src/renderer/src/copy'
import {
  QUESTION_1, QUESTION_2, fakeCodexEnv, questionMessage, questionProject, replyFile, scratch, seedChat, userDataWith
} from './fixtures/fake-codex'

/** 보통 입력칸의 표식 — 카드가 떠 있으면 이 자리에 없다. */
const COMPOSER = `textarea[aria-label="${CHAT.placeholder}"]`
const OPTION_1 = '1) 농협 공판장'
const OPTION_2 = '2) 온라인 직거래'

test('질문 카드가 입력칸을 덮고, 빠른 1·2 에도 학생 메시지는 하나다', async () => {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [questionMessage()])
  const env = fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, QUESTION_2) })
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const card = page.locator('.qcard')
    await expect(card).toBeVisible({ timeout: 30_000 })
    // 카드가 뜨면 입력칸은 없다 — "쳐야 해? 눌러야 해?"가 생기지 않게.
    expect(await page.locator(COMPOSER).count()).toBe(0)
    // 보기 마지막 줄은 앱이 늘 붙이는 "직접 입력"이다.
    await expect(card.locator('.qcard-opts > *').last()).toHaveText(CHAT.directInput)
    await expect(card.locator('.qcard-q')).toHaveText('지금 블루베리를 주로 어디에 팔고 있나요?')
    // 대화 원문은 보기 목록을 접고 자리를 카드에 내준다 — 글자는 남아 있다.
    await expect(page.locator('.chat-msg.assistant .q-fold')).toBeVisible()

    // 첫 선택에서 잠기므로 연타해도 답은 하나다(검토 R1-04).
    await card.focus()
    await card.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }))
    })
    await expect(page.locator('.chat-msg.user')).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator('.chat-msg.user').first()).toContainText(OPTION_1)
    // 왕복이 끝나면 다음 질문 카드가 같은 자리에 온다.
    await expect(page.locator('.qcard')).toContainText('임차료는 내년에 한 번 오르나요', { timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})

test('보기를 누르면 곧바로 보내고, 보낸 말은 스킬이 받는 형식 그대로다', async () => {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [questionMessage()])
  const env = fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, QUESTION_2) })
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const card = page.locator('.qcard')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole('radio', { name: /온라인 직거래/ }).click()
    await expect(page.locator('.chat-msg.user')).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator('.chat-msg.user').first()).toContainText(OPTION_2)
    // ` — ` 뒤 설명이 빠지는지는 단위 시험이 본다(optionAnswer) — 보낸 말은 스킬이 받는 형식 그대로.
    await expect(page.locator('.qcard')).toContainText('임차료는 내년에 한 번 오르나요', { timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})

test('직접 입력: Esc 로 되돌아가도 글이 남고, Enter 로 보낸다', async () => {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [questionMessage()])
  const env = fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, QUESTION_2) })
  const typed = '1000평 중에 300평은 체험용이라 직접 따서 가져가요'
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const card = page.locator('.qcard')
    await expect(card).toBeVisible({ timeout: 30_000 })

    await card.locator('.qopt.free').click()
    const box = card.locator('.freebox textarea')
    await expect(box).toBeVisible()
    // 직접 입력 중에도 위 보기는 그대로 남는다(시안 E · 검토 P1-R1-04).
    await expect(card.getByRole('radio')).toHaveCount(4)
    await box.fill(typed)

    // Esc 는 보기로 되돌아간다. 초안은 건드리지 않는다.
    await page.keyboard.press('Escape')
    await expect(card.locator('.freebox')).toHaveCount(0)
    await expect(card.locator('.qopt.free')).toBeVisible()

    // 다시 펼치면 쓰던 글이 그대로 있다 — 직접 입력 칸과 보통 입력칸은 같은 초안 하나를 쓴다.
    await card.locator('.qopt.free').click()
    await expect(card.getByRole('radio')).toHaveCount(4)
    await expect(card.locator('.freebox textarea')).toHaveValue(typed)

    await card.locator('.freebox textarea').press('Enter')
    await expect(page.locator('.chat-msg.user')).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator('.chat-msg.user').first()).toContainText('체험용')
  } finally {
    await electronApp.close()
  }
})

test('직접 입력 중에 보기를 눌러도 초안이 남고 그 보기가 전송된다 (검토 P1-R1-04)', async () => {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [questionMessage()])
  const env = fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, QUESTION_2) })
  const kept = '내 사정은 따로 적어 둔다'
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const card = page.locator('.qcard')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.locator('.qopt.free').click()
    await card.locator('.freebox textarea').fill(kept)

    await card.getByRole('radio', { name: /온라인 직거래/ }).click()
    await expect(page.locator('.chat-msg.user')).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator('.chat-msg.user').first()).toContainText(OPTION_2)

    // 다음 질문 카드에서 직접 입력을 열면 쓰던 초안이 그대로다 — 보기 전송은 초안을 건드리지 않는다.
    await expect(page.locator('.qcard')).toBeVisible({ timeout: 30_000 })
    await page.locator('.qopt.free').click()
    await expect(page.locator('.freebox textarea')).toHaveValue(kept)
  } finally {
    await electronApp.close()
  }
})

test('앱을 껐다 켜도 카드의 직접 입력 초안이 남는다', async () => {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [questionMessage()])
  const env = fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' })
  const userData = `${dir}/userdata`
  const typed = '쓰다 만 답'

  const first = await launch({ env, userData })
  await openProject(first.page, root)
  await expect(first.page.locator('.qcard')).toBeVisible({ timeout: 30_000 })
  await first.page.locator('.qopt.free').click()
  await first.page.locator('.freebox textarea').fill(typed)
  await first.electronApp.close()

  const second = await launch({ env, userData })
  try {
    await openProject(second.page, root)
    await expect(second.page.locator('.qcard')).toBeVisible({ timeout: 30_000 })
    await second.page.locator('.qopt.free').click()
    await expect(second.page.locator('.freebox textarea')).toHaveValue(typed)
  } finally {
    await second.electronApp.close()
  }
})

test('허락 상태에서는 질문 카드 대신 허락 카드만 보인다', async () => {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [questionMessage()])
  const env = fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_ASK: '1' })
  // 전역 기본이 '묻지 않기'면 허락은 자동으로 통과된다 — 카드 장면을 보려면 'ask' 여야 한다.
  const { electronApp, page } = await launch({ env, userData: userDataWith(dir, { permission_mode: 'ask' }) })
  try {
    await openProject(page, root)
    const card = page.locator('.qcard')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole('radio', { name: /농협 공판장/ }).click()

    const ask = page.locator('.askcard')
    await expect(ask).toBeVisible({ timeout: 30_000 })
    await expect(ask).toContainText(CHAT.askTitle)
    await expect(ask).toContainText('cat /etc/hosts')
    // 아래 칸은 하나뿐이다 — 질문 카드도 입력칸도 자리를 나눠 갖지 않는다.
    expect(await page.locator('.qcard').count()).toBe(0)
    expect(await page.locator(COMPOSER).count()).toBe(0)
  } finally {
    await electronApp.close()
  }
})

test('작업 중에는 한 줄이 뜨고 입력칸은 살아 있으며 보내기 자리가 멈추기가 된다', async () => {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [questionMessage()])
  const env = fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_HOLD: '1' })
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const card = page.locator('.qcard')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole('radio', { name: /농협 공판장/ }).click()

    // 작업 중 진행 표시는 정확히 하나 — 아직 보내는 중이라 말풍선 밖 글자다(전송 중 A안).
    await expect(page.locator(PROGRESS)).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator('.deliv[data-st="sending"]')).toBeVisible()
    await expect(page.locator('.deliv[data-st="sending"]')).toContainText(CHAT.sendingLine)
    // 다음 말을 미리 써 둘 수 있어야 한다 — 입력칸은 살아 있고 보내기만 막힌다.
    const composer = page.locator(COMPOSER)
    await expect(composer).toBeVisible()
    await expect(composer).toBeEnabled()
    const stop = page.locator('.chat-composer button.send')
    // 보내기 자리는 원형 아이콘 단추가 됐다 — 이름은 화면 낭독용 aria-label 이 갖는다(발주 I-01).
    await expect(stop).toHaveAttribute('aria-label', CHAT.stop)

    // 작업 중 Enter 도 보내지 않는다 — 단추만 막으면 main 의 소유권 잠금에 걸려
    // "현재 작업이 끝나거나 중단된 뒤 다시 실행해 주세요."가 뜬다(검토 P1-R1-03).
    await composer.fill('작업 중에 미리 써 둔 다음 말')
    await composer.press('Enter')
    await expect(page.locator('.chat-msg.user')).toHaveCount(1)
    await expect(page.locator('text=현재 작업이 끝나거나 중단된 뒤')).toHaveCount(0)
    await expect(composer).toHaveValue('작업 중에 미리 써 둔 다음 말')

    await stop.click()
    await expect(page.locator(`text=${CHAT.stoppedTitle}`)).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(PROGRESS)).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})
