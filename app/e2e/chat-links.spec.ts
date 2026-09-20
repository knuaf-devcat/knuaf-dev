/**
 * GUI 감사 GUI-12: 완료 답변의 파일 링크가 마크다운 원문으로 보이고, 접근성 역할도
 * 일반 텍스트였다. 결과물 메뉴로 돌아가야만 파일에 닿을 수 있었다.
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'

const TEXT = '검토본을 만들었어요. [검토전_본문.md](build/검토전_본문.md) 에서 볼 수 있어요.'

test('도우미 답변의 파일 링크가 마크다운 원문으로 보이지 않는다 (GUI-12)', async () => {
  const root = synthProject()
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  for (const p of ['codex', 'claude'])
    writeFileSync(join(root, '.knuaf-gui', `chat-${p}.json`), JSON.stringify({
      root, provider: p, state: 'idle',
      messages: [{ id: 'a1', role: 'assistant', text: TEXT, at: new Date().toISOString() }]
    }), 'utf-8')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.getByRole('heading', { name: '내 논문' }).waitFor()
    const msg = page.locator('.chat-msg.assistant .prose').first()
    await expect(msg).toBeVisible({ timeout: 30_000 })

    expect(await msg.innerText(), '마크다운 원문이 그대로 보인다').not.toContain('](')
    // 일반 텍스트가 아니라 누를 수 있는 것이어야 한다 — 접근성 트리에도 역할이 생긴다.
    const link = page.getByRole('button', { name: '검토전_본문.md' })
    await expect(link, '파일 이름이 누를 수 있는 것이 아니다').toBeVisible()
    await link.click()
    await expect(page.getByRole('heading', { name: '결과물' })).toBeVisible({ timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})

/**
 * 안전 쪽 절반. 도우미가 쓴 링크를 무엇이든 누를 수 있게 만들면 답변 텍스트가 곧
 * 실행 권한이 된다. 프로젝트 안 상대경로가 아닌 것은 원문 그대로 둔다 — 감추지도,
 * 누를 수 있게 만들지도 않는다.
 */
test('폴더 밖·주소를 가리키는 링크는 누를 수 있게 만들지 않는다 (GUI-12)', async () => {
  const root = synthProject()
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  const text = [
    '[받으세요](https://example.invalid/x.exe)',
    '[열쇠](/Users/other/.ssh/id_rsa)',
    '[위로](../../다른폴더/x.md)'
  ].join(' 그리고 ')
  for (const p of ['codex', 'claude'])
    writeFileSync(join(root, '.knuaf-gui', `chat-${p}.json`), JSON.stringify({
      root, provider: p, state: 'idle',
      messages: [{ id: 'a2', role: 'assistant', text, at: new Date().toISOString() }]
    }), 'utf-8')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.getByRole('heading', { name: '내 논문' }).waitFor()
    const msg = page.locator('.chat-msg.assistant .prose').first()
    await expect(msg).toBeVisible({ timeout: 30_000 })
    for (const label of ['받으세요', '열쇠', '위로'])
      await expect(page.getByRole('button', { name: label }), `${label} 가 눌러진다`).toHaveCount(0)
    // 감추지는 않는다 — 학생이 무엇이 적혔는지 볼 수 있어야 한다.
    await expect(msg).toContainText('example.invalid')
  } finally {
    await electronApp.close()
  }
})
