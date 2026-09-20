import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, openProject, python, scripts, synthProject } from './helpers'

const OUT = resolve(__dirname, 'artifacts')

/** Apply a second change on top of the synth project (revision 1 → 2). */
function applyChange(root: string, change: object, expected: number): void {
  const file = join(root, `change-${expected}.json`)
  writeFileSync(file, JSON.stringify(change), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', file, '--expected-revision', String(expected)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

const intakeFact = (id: string, field: string, value: string | null, state: string, extra: object = {}) => ({
  collection: 'facts',
  value: {
    id, field_id: field, kind: 'reported_fact', value,
    unit: null, value_type: 'text', period: null, scope: null,
    answer_state: state, verification: 'unreviewed',
    source_refs: [{ id: 'src-answers', revision: 1, locator: 'L1' }],
    ...extra
  }
})

test('자료 화면: 현재 작성물과 참고자료 구분 표시, 파일을 답변에 첨부', async () => {
  const root = synthProject()
  writeFileSync(join(root, 'sources', '초고.docx'), 'docx')
  applyChange(root, {
    request_id: 'e2e:intake:1',
    ops: [
      intakeFact('fact-manuscript', 'intake.current_manuscript', 'sources/초고.docx', 'provided'),
      intakeFact('fact-basis', 'intake.work_basis', '이어쓰기', 'provided')
    ]
  }, 1)
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await page.waitForSelector('h1:has-text("내 논문")', { timeout: 30_000 })
  await page.click('nav >> text=자료')
  await page.waitForSelector('h1:has-text("자료")', { timeout: 30_000 })

  // decided manuscript shows the file; finance stays undecided
  await expect(page.locator('text=현재 원고')).toBeVisible()
  await expect(page.locator('text=초고.docx').first()).toBeVisible()
  await expect(page.locator('text=재무 파일')).toBeVisible()
  await expect(page.locator('text=아직 정해지지 않았어요').first()).toBeVisible()

  // sources/ files show filename in the head, relative path only in the caption;
  // the manuscript is marked current, other files carry no badge
  const manuscriptRow = page.locator('.item', { hasText: '초고.docx' })
  await expect(manuscriptRow.locator('text=현재 작성물')).toBeVisible()
  const answersRow = page.locator('.item', { hasText: 'answers.md' })
  await expect(answersRow.locator('.head strong')).toHaveText('answers.md')
  await expect(answersRow.locator('.badge')).toHaveCount(0)
  // 점검 링크가 본문 끝에 있고 점검 화면으로 이어진다
  await page.click('button.lk:has-text("점검")')
  await page.waitForSelector('h1:has-text("점검")', { timeout: 30_000 })
  await page.click('nav >> text=자료')
  await page.waitForSelector('h1:has-text("자료")', { timeout: 30_000 })
  // no auto-adoption: the caption is always present
  await expect(page.locator('text=넣는 것만으로 현재 작성물이 되지는 않아요')).toBeVisible()

  mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: join(OUT, 'materials.png') })

  // attaching puts the absolute path into the answer draft and moves to 내 논문.
  // connected → composer textarea; agent-less machine (CI) → the draft copy card
  // holds it instead, so the draft is never silently swallowed. count() 를 바로 찍으면
  // 상태 조회가 아직 안 끝난 순간을 볼 수 있으니, 둘 중 하나가 자리 잡을 때까지 기다린다.
  await manuscriptRow.locator('button:has-text("답변에 첨부")').click()
  await page.waitForSelector('h1:has-text("내 논문")', { timeout: 30_000 })
  const draftTarget = page.locator('textarea').or(page.locator('.card', { hasText: '도우미에게 보낼 요청' }).locator('.prose'))
  await expect(draftTarget.first()).toBeVisible({ timeout: 30_000 })
  const ta = page.locator('textarea')
  if (await ta.count()) expect(await ta.inputValue()).toContain(join('sources', '초고.docx'))
  else await expect(page.locator('.card', { hasText: '도우미에게 보낼 요청' }).locator('.prose')).toContainText(join('sources', '초고.docx'))
  await electronApp.close()
})
