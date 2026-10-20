/**
 * 빈 입력칸의 추천 문구 — CLI 가 보여 주는 `Try "…"` 자리.
 *
 * 고르는 규칙은 순수 함수(`suggest.ts`) 하나에 있고, 화면은 그것을 placeholder 로 그리고
 * → 키로 **채우기만** 한다(보내지 않는다). 앞부분은 Electron 없이, 화면 시험은 실제 창에서 본다.
 */
import { expect, test } from '@playwright/test'
import { launch, openProject, synthProject } from './helpers'
import { CHAT, SUGGEST } from '../src/renderer/src/copy'
import { chatSuggestion, situationOf, type SuggestInput } from '../src/renderer/src/suggest'
import { fakeCodexEnv, scratch, seedChat } from './fixtures/fake-codex'

const COMPOSER = `textarea[aria-label="${CHAT.placeholder}"]`
const at = (min: number): string => new Date(Date.now() - min * 60_000).toISOString()

type Stage = SuggestInput['stage']
const stage = (now: Stage['now'], over: Partial<Stage> = {}): Stage => ({
  now, sections: [], writingIndex: -1, stale: false, ...over
})
/** 대화가 있는, 흔한 상태 — 상황 판정 시험의 바탕이다. */
const input = (over: Partial<SuggestInput> = {}): SuggestInput => ({
  hasMessages: true, hasQuote: false, running: false, lastAssistant: null,
  stage: stage(2), userCount: 0, ...over
})
const sections = [
  { id: 's1', title: 'Ⅰ. 머리말', status: 'review_ready' },
  { id: 's2', title: 'Ⅱ. 창업 아이템', status: 'drafting' }
]

// ------------------------------------------------------------------ 상황 판정

test('예시를 띄우지 않는 네 경우 — 빈 대화·인용·작업 중·1단계', () => {
  expect(situationOf(input({ hasMessages: false })), '빈 대화').toBeNull()
  expect(situationOf(input({ hasQuote: true })), '인용').toBeNull()
  expect(situationOf(input({ running: true })), '작업 중').toBeNull()
  expect(situationOf(input({ stage: stage(1) })), '1단계').toBeNull()
  for (const i of [input({ hasMessages: false }), input({ hasQuote: true }), input({ running: true }), input({ stage: stage(1) })]) {
    expect(chatSuggestion(i)).toBeNull()
  }
})

test('도우미가 값을 물으면 값 입력형, 생각을 물으면 서술형', () => {
  const value = '재배 예정 면적을 알려달라. (평 또는 ㎡)\n예: 600평 / 2,000㎡ / 아직 미정'
  expect(situationOf(input({ lastAssistant: value }))).toBe('answer-value')
  const open = '농장명을 짓게 된 배경을 알려달라.\n(관련 소개 절의 글감으로 사용한다. 짧게 답해도 된다)'
  expect(situationOf(input({ lastAssistant: open }))).toBe('answer-open')
  // 물음표만 있는 질문도 질문이다.
  expect(situationOf(input({ lastAssistant: '지금 주로 어디에 파나요?' }))).toBe('answer-open')
  expect(situationOf(input({ lastAssistant: '단위는 무엇인가요?\n(평 또는 ㎡)' })), '단위가 붙은 질문').toBe('answer-value')
  // 선택형 질문은 QuestionCard 가 입력칸 자리를 차지한다 — 그 밖의 자유 입력형도 질문이다.
  expect(situationOf(input({ lastAssistant: '어느 쪽이 좋나요?\n\n→ 번호 또는 자유 입력' }))).toBe('answer-open')
})

test('질문이 없는 보고문은 단계 상황으로 간다', () => {
  const report = 'Ⅰ. 머리말을 저장했어요. 다음은 Ⅱ. 창업 아이템이에요.'
  expect(situationOf(input({ lastAssistant: report, stage: stage(2, { writingIndex: 1 }) }))).toBe('writing')
  expect(situationOf(input({ lastAssistant: report, stage: stage(3) }))).toBe('all-written')
})

test('단계별 상황 — 2단계는 쓰는 장 유무, 3·4·5단계는 각각 하나', () => {
  expect(situationOf(input({ stage: stage(2, { sections, writingIndex: -1 }) }))).toBe('start-writing')
  expect(situationOf(input({ stage: stage(2, { sections, writingIndex: 1 }) }))).toBe('writing')
  expect(situationOf(input({ stage: stage(3, { sections }) }))).toBe('all-written')
  expect(situationOf(input({ stage: stage(4, { sections, stale: true }) }))).toBe('stale')
  expect(situationOf(input({ stage: stage(4, { sections }) }))).toBe('finishing')
  expect(situationOf(input({ stage: stage(5, { sections }) }))).toBe('finishing')
})

test('상황마다 문구가 있고, 보낸 말 수만큼 돌아 처음으로 돌아온다', () => {
  const all = Object.entries(SUGGEST)
  expect(all.map(([k]) => k).sort()).toEqual([
    'all-written', 'answer-open', 'answer-value', 'finishing', 'stale', 'start-writing', 'writing'
  ])
  for (const [name, list] of all) {
    expect(list.length, `${name} 문구가 없다`).toBeGreaterThan(0)
    for (const s of list) expect(s.trim(), `${name} 의 빈 문구`).not.toBe('')
  }
  // 값 입력형 — `{장}` 이 없으니 userCount 가 그대로 자리를 고른다.
  const pick = (userCount: number): string | null => chatSuggestion(input({ lastAssistant: '면적을 알려달라. (평)', userCount }))
  const list = SUGGEST['answer-value']
  expect(list.map((_, i) => pick(i))).toEqual([...list])
  expect(pick(list.length), '한 바퀴 돌면 처음').toBe(list[0])
})

// ------------------------------------------------------------------ 장 제목

test('{장} 은 쓰는 장(다 썼으면 마지막 장) 제목으로 바뀌고, 16자를 넘으면 자른다', () => {
  const writing = input({ stage: stage(2, { sections, writingIndex: 1 }) })
  expect(chatSuggestion(writing)).toBe('\'Ⅱ. 창업 아이템\' 이어서 써 주세요')

  const done = input({ stage: stage(3, { sections }), userCount: 1 })
  expect(chatSuggestion(done)).toBe('\'Ⅱ. 창업 아이템\' 다시 읽고 어색한 문장을 고쳐 주세요')

  const long = [{ id: 's1', title: 'Ⅲ. 시장 분석과 판로 전략 수립', status: 'drafting' }]
  expect(chatSuggestion(input({ stage: stage(2, { sections: long, writingIndex: 0 }) })))
    .toBe('\'Ⅲ. 시장 분석과 판로 전략…\' 이어서 써 주세요')
  // 16자 이하는 그대로 쓴다.
  const fits = [{ id: 's1', title: 'Ⅱ. 창업 아이템 소개', status: 'drafting' }]
  expect(chatSuggestion(input({ stage: stage(2, { sections: fits, writingIndex: 0 }) })))
    .toBe('\'Ⅱ. 창업 아이템 소개\' 이어서 써 주세요')
})

test('제목이 비면 {장} 이 든 문구는 건너뛰고 다음 문구를 쓴다', () => {
  const blank = [{ id: 's1', title: '', status: 'drafting' }]
  expect(chatSuggestion(input({ stage: stage(2, { sections: blank, writingIndex: 0 }) })))
    .toBe(SUGGEST.writing[1])
  // 어느 상황에서도 제목 자리에 `{장}` 이 그대로 새어 나오지 않는다.
  for (const now of [2, 3] as const) {
    for (let userCount = 0; userCount < 4; userCount++) {
      const text = chatSuggestion(input({ stage: stage(now, { sections: blank, writingIndex: 0 }), userCount }))
      expect(text ?? '', `${now}단계 ${userCount}`).not.toContain('{장}')
    }
  }
})

// ------------------------------------------------------------------ 화면

test('마지막이 값 입력형 질문인 대화를 열면 그 상황의 예시가 뜨고, → 키는 채우기만 한다', async () => {
  const dir = scratch()
  const root = synthProject()
  seedChat(root, [
    { id: 'u0', role: 'user', text: '블루베리 농장이에요', at: at(3), delivery: 'sent' },
    { id: 'a0', role: 'assistant', text: '재배 예정 면적을 알려달라. (평 또는 ㎡)\n예: 600평 / 2,000㎡ / 아직 미정', at: at(2) }
  ])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    const ta = page.locator(COMPOSER)
    await expect(ta).toBeVisible({ timeout: 30_000 })

    // 학생 메시지 1개 → 값 입력형 목록의 두 번째 문구. 접근 이름은 placeholder 와 달리 고정이다.
    const expected = SUGGEST['answer-value'][1]
    await expect(ta).toHaveAttribute('placeholder', CHAT.suggestionPlaceholder(expected))
    await expect(ta).toHaveAttribute('aria-label', CHAT.placeholder)

    const users = page.locator('.chat-thread .chat-msg.user')
    await expect(users, '시험 전제: 학생 메시지 1개').toHaveCount(1)

    await ta.click()
    await ta.press('ArrowRight')
    await expect(ta, '→ 키가 예시를 채우지 않았다').toHaveValue(expected)
    // 채우기만 한다 — 커서는 끝에 오고, 보내지 않으므로 학생 메시지 수는 그대로다.
    expect(await ta.evaluate((el) => (el as HTMLTextAreaElement).selectionStart), '커서가 끝에 있지 않다')
      .toBe(expected.length)
    await expect(users, '→ 키가 메시지를 보냈다').toHaveCount(1)
    await expect(page.locator('.chat-thread')).not.toContainText(expected)

    // 글이 있으면 → 는 아무 일도 하지 않는다(학생이 커서를 옮기려는 것일 수 있다).
    await ta.fill('내가 쓴 글')
    await ta.press('ArrowRight')
    await expect(ta).toHaveValue('내가 쓴 글')
  } finally {
    await electronApp.close()
  }
})

test('단계 상황 — 쓰는 장이 있으면 그 장 제목이 든 예시가 뜬다', async () => {
  const dir = scratch()
  const root = synthProject()
  // 질문이 아닌 보고문 하나 + `sections/01.md`(status `drafting`) → 2단계 `writing`, 학생 말 수 0.
  seedChat(root, [{ id: 'a0', role: 'assistant', text: 'Ⅰ. 머리말을 저장했어요. 다음은 Ⅱ. 창업 아이템이에요.', at: at(2) }])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    const ta = page.locator(COMPOSER)
    await expect(ta).toBeVisible({ timeout: 30_000 })
    const expected = '\'Ⅰ. 머리말\' 이어서 써 주세요'
    await expect(ta).toHaveAttribute('placeholder', CHAT.suggestionPlaceholder(expected))
    await ta.press('ArrowRight')
    await expect(ta).toHaveValue(expected)
  } finally {
    await electronApp.close()
  }
})

test('인용이 붙으면 예시 대신 기존 안내 문구가 돌아온다', async () => {
  const dir = scratch()
  const root = synthProject()
  seedChat(root, [
    { id: 'u0', role: 'user', text: '블루베리 농장이에요', at: at(3), delivery: 'sent' },
    { id: 'a0', role: 'assistant', text: '재배 예정 면적을 알려달라. (평 또는 ㎡)\n예: 600평 / 2,000㎡ / 아직 미정', at: at(2) }
  ])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    const ta = page.locator(COMPOSER)
    await expect(ta).toBeVisible({ timeout: 30_000 })
    await expect(ta).toHaveAttribute('placeholder', CHAT.suggestionPlaceholder(SUGGEST['answer-value'][1]))

    // 종이에서 문단을 골라 "고쳐 달라기" — 인용 칩이 붙는다(review.spec.ts 와 같은 길).
    await expect(page.locator('.paperpane .sheet')).toContainText('600평', { timeout: 30_000 })
    await page.evaluate(() => {
      const p = [...document.querySelectorAll('.sheet p')].find((el) => (el.textContent ?? '').includes('600평'))
      if (!p) throw new Error('문단을 찾지 못했다')
      const range = document.createRange()
      range.selectNodeContents(p)
      const sel = window.getSelection()
      if (!sel) throw new Error('선택을 만들 수 없다')
      sel.removeAllRanges(); sel.addRange(range)
      p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.locator('.selbar').getByRole('button', { name: '고쳐 달라기' }).click()
    await expect(page.locator('.review-chip')).toBeVisible()

    await expect(ta, '인용이 붙었는데 예시가 남아 있다').toHaveAttribute('placeholder', CHAT.placeholder)
    await ta.press('ArrowRight')
    await expect(ta, '인용이 있을 때 → 키가 글을 채웠다').toHaveValue('')
  } finally {
    await electronApp.close()
  }
})
