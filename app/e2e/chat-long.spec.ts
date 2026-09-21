/**
 * 시험주행 발견 10·4 — 대화 화면이 긴 답변을 다루는 방식.
 *
 * 10: 도구 보고 원문 20,600자가 한 말풍선으로 통째로 들어와 대화가 사람이 지나갈 수
 *     없는 길이가 됐다. 내용을 버리지 않으면서 접을 수 있어야 한다.
 * 4:  "방금 한 일" 카드가 답변의 첫 줄을 그대로 집는데, 도우미 답변은 `> knuaf-doc · …`
 *     머리글로 시작할 때가 있어서 배너만 되뇌는 빈 카드가 됐다. 바로 위 말풍선과
 *     같은 줄이 한 번 더 보여 학생에게는 같은 말이 두 번 뜬 것으로 읽힌다.
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import { CHAT } from '../src/renderer/src/copy'

const BANNER = '> knuaf-doc · 창업논문 작성 도우미'
const TAIL = '여기가 답변의 맨 끝입니다'
/** 앞머리는 배너·인용, 본문은 2,000자 한도를 훌쩍 넘긴다. */
const LONG = `${BANNER}\n> prod. 시험용\n\n강의자료 발췌본을 그대로 옮깁니다.\n${'슬라이드 내용 '.repeat(500)}\n${TAIL}`

function seedChat(root: string): void {
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  writeFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), JSON.stringify({
    root, provider: 'codex', state: 'idle',
    messages: [
      { id: 'u1', role: 'user', text: '자료를 읽어 주세요', at: new Date().toISOString(), delivery: 'sent' },
      { id: 'a1', role: 'assistant', text: LONG, at: new Date().toISOString() }
    ]
  }), 'utf-8')
}

test('긴 답변은 접히고, 펼치면 전문이 그대로 있다 (발견 10)', async () => {
  const root = synthProject()
  seedChat(root)
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('h1', { hasText: '내 논문' })).toBeVisible()

    const bubble = page.locator('.chat-msg.assistant').first()
    await expect(bubble).toBeVisible({ timeout: 30_000 })
    await expect(bubble, '접혀 있어야 하는데 전문이 다 보인다').not.toContainText(TAIL)

    const more = bubble.getByRole('button', { name: /더 보기$/ })
    await expect(more, '긴 답변에 "더 보기"가 없다').toBeVisible()
    await more.click()
    // 내용을 버리지 않는다 — 펼치면 끝까지 있다.
    await expect(bubble, '펼쳤는데 전문이 없다').toContainText(TAIL)

    await bubble.getByRole('button', { name: CHAT.showLess }).click()
    await expect(bubble).not.toContainText(TAIL)
  } finally {
    await electronApp.close()
  }
})

test('"방금 한 일"이 답변 머리글을 되뇌지 않는다 (발견 4)', async () => {
  const root = synthProject()
  seedChat(root)
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('h1', { hasText: '내 논문' })).toBeVisible()

    const title = page.locator('.activity .title')
    await expect(title).toBeVisible({ timeout: 30_000 })
    const text = (await title.innerText()).trim()
    expect(text, '머리글(배너) 줄을 그대로 집었다').not.toContain('knuaf-doc ·')
    expect(text.startsWith('>'), '인용 줄을 제목으로 삼았다').toBe(false)
  } finally {
    await electronApp.close()
  }
})
