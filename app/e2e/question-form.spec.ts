import { expect, test } from '@playwright/test'
import { parseQuestionForm } from '../src/shared/question-form'
import { zoneOf } from '../src/shared/zone'
import { launch, openProject } from './helpers'
import { fakeCodexEnv, questionMessage, questionProject, scratch, seedChat } from './fixtures/fake-codex'

const Q = `[Q2] 기본 계획

각각 알려주세요.

1. 전공 (학과 소속)
   예: 특용작물전공 / 채소전공
   미정이면: 학과를 알려주세요

2. 자금 (자기자본과 융자를 나눠서)
   가족 지원이 있으면 적어주세요
   예: 자기자본 1억
   미정이면: 표준 모델을 제시합니다
   (확인 후 시범값으로 진행합니다)

각 항목에 값을 적거나 미정이라고 답해주세요.`
test('윈도우 기본 계획의 같은 줄 설명과 예시를 분리한다', () => {
  const text = `**[Q2] 기본 계획**
다음 세 가지를 번호별로 알려주세요.

1. **전공(학과 소속)** — 예: 채소전공
2. **창업 예정 지역(시·군)** — 예: 전북 완주군. 미정이면 "미정"
3. **가용 자금** — 자기자본과 대출 예정액을 나눠 적어주세요. 예: 자기자본 5천만 원, 대출 1억 원. 아직 정하지 않았다면 "미정"

한 줄로 \`채소전공 / 완주군 / 자기자본 5천만 원, 대출 1억 원\`처럼 답해도 됩니다.`
  const form = parseQuestionForm(text)!
  expect(form.fields.map(f => f.label)).toEqual(['전공', '창업 예정 지역', '가용 자금'])
  expect(form.fields[0].description).toBe('학과 소속')
  expect(form.fields[1].example).toBe('예: 전북 완주군. 미정이면 "미정"')
  expect(form.fields[2].description).toBe('자기자본과 대출 예정액을 나눠 적어주세요')
  expect(form.fields[2].example).toContain('예: 자기자본 5천만 원')
  expect(parseQuestionForm(text.replace('2. **', '2) **'))).toBeNull()
})

test('윈도우 화면 인용을 참고한 금액 질문 변형과 칸 설명 분리', () => {
  const money = `[Q2-4] 창업에 사용할 자금은 대략 얼마로 생각하시나요?
1. 자기자본: 직접 마련할 금액
2. 융자·정책자금: 빌리거나 신청할 계획 금액
예: \`자기자본 5천만 원, 융자 1억 원\``
  expect(parseQuestionForm(money)).toBeNull()
  const form = parseQuestionForm(`**[Q2] 기본 계획**
1. 자기자본: 직접 마련할 금액
2. 융자·정책자금: 빌리거나 신청할 계획 금액`)!
  expect(form.title).toBe('기본 계획')
  expect(form.fields.map(f => [f.label, f.description])).toEqual([
    ['자기자본', '직접 마련할 금액'], ['융자·정책자금', '빌리거나 신청할 계획 금액']
  ])
})

test('공백 없는 쌍점은 항목 이름에 보존하고 공백 뒤 설명만 분리한다', () => {
  const form = parseQuestionForm(`[Q2] 기본 계획
1. 자기자본:융자 비율
2. 지역: 창업 예정 지역`)!
  expect(form.fields.map(f => [f.label, f.description])).toEqual([
    ['자기자본:융자 비율', ''], ['지역', '창업 예정 지역']
  ])
})
test('맥 저장 대화의 금액 질문은 보통 입력이다', () => {
  const text = `[Q2-4] 자금 계획 · 재무계획에 사용  
준비 가능한 자기자본과 융자는 각각 얼마인가요? 가족 지원이 있다면 금액과 증여·대여 여부도 알려주세요.  
예: 자기자본 1억 원(가족 지원 5천만 원 포함), 융자 3억 원  
아직 정해지지 않았다면 ‘미정’이라고 답해 주세요.`
  expect(parseQuestionForm(text)).toBeNull()
})


test('여러 칸과 설명을 보존하고 애매한 번호는 거부한다', () => {
  const form = parseQuestionForm(Q)!
  expect(form.fields[1]).toEqual({ label: '자금', description: '자기자본과 융자를 나눠서', example: '예: 자기자본 1억', undecided: '표준 모델을 제시합니다 (확인 후 시범값으로 진행합니다)', notes: ['가족 지원이 있으면 적어주세요'] })
  expect(parseQuestionForm(Q.replace('2. 자금', '3. 자금'))).toBeNull()
  expect(parseQuestionForm(Q.replace('2. 자금', '2) 자금'))).toBeNull()
  expect(parseQuestionForm(Q.replace('2. 자금', '다른 질문입니다\n2. 자금'))).toBeNull()
  expect(parseQuestionForm('[Q2] 하나\n1. 전공')).toBeNull()
  expect(parseQuestionForm(`${Q}\n3. 다른 질문`)).toBeNull()
  expect(parseQuestionForm('[Q2-2] 농장 개요\n1. 농장명\n2. 규모')).not.toBeNull()
  const connection = { installed: true, connected: true, version: '', detail: '' }
  const message = { id: 'a', role: 'assistant' as const, text: Q, at: '' }
  expect(zoneOf({ root: '/p', provider: 'codex', state: 'idle', messages: [message] }, connection, null).kind).toBe('form')
  expect(zoneOf({ root: '/p', provider: 'codex', state: 'idle', messages: [message, { ...message, id: 'u', role: 'user' }] }, connection, null).kind).toBe('composer')
})

test('질문창에서 모든 답을 명시하고 한 메시지로 보낸다', async () => {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [questionMessage('form', Q)])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    const form = page.locator('.qform')
    await expect(form).toBeVisible({ timeout: 30000 })
    await expect(form.getByText('보낼 답', { exact: true })).toHaveCount(0)
    await expect(form.locator('.qform-head')).toContainText('0 / 2 채움')
    await expect(form.getByLabel('1. 전공')).toHaveValue('')
    await expect(form.getByLabel('2. 자금')).toHaveValue('')
    await expect(page.locator('.chat-msg.assistant')).toContainText('각각 알려주세요')
    await expect(form.getByRole('button', { name: '보내기' })).toBeDisabled()
    await form.getByLabel('1. 전공').fill('특용작물전공')
    await expect(form.locator('.qform-head')).toContainText('1 / 2 채움')
    await expect(form.getByLabel('2. 자금')).toHaveValue('')
    await expect(form.getByRole('button', { name: '보내기' })).toBeDisabled()
    await form.getByLabel('1. 전공').press('Tab')
    await expect(form.getByLabel('2. 자금')).toBeFocused()
    await form.getByRole('button', { name: '직접 입력' }).click()
    await expect(page.locator('.chat-composer textarea')).toBeVisible()
    await page.getByRole('button', { name: '질문창으로 돌아가기' }).click()
    await expect(form.getByLabel('1. 전공')).toHaveValue('특용작물전공')
    await form.getByRole('button', { name: '미정' }).nth(1).click()
    await expect(form).toContainText('표준 모델을 제시합니다')
    await expect(form.locator('input').nth(1)).toBeDisabled()
    await expect(form.locator('.qform-head')).toContainText('2 / 2 채움')
    await expect(form.getByRole('button', { name: '보내기' })).toBeEnabled()
    await form.locator('input').first().press('Enter')
    await expect(page.locator('.chat-msg.user')).toHaveCount(1, { timeout: 30000 })
    await expect(page.locator('.chat-msg.user').first()).toHaveText('1. 전공: 특용작물전공\n2. 자금: 미정')
  } finally { await electronApp.close() }
})
