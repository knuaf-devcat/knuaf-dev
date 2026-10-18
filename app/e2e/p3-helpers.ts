import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { python, scripts } from './helpers'

/**
 * 단계 3-B 시험용 도우미 — `helpers.ts` 를 건드리지 않는다.
 *
 * 3-B 가 사이드바를 없앴으므로 `helpers.ts` 의 `navTo`(nav 버튼)와 `openProject`(navTo 로
 * 설정에 먼저 가는 길)는 더 이상 통하지 않는다. 그 파일은 지금 **다른 작업**
 * (feat/gui-v5-hidden, Electron 창을 띄우지 않는 e2e)이 손대고 있어 여기서는 건드리지 않고,
 * v5 진입점으로 여는 길만 여기에 새로 둔다. 그 작업이 합류하면 `helpers.ts` 한 곳으로
 * 흡수한다(발주 ③ 책임자 의견 ②: navTo 를 한 곳에서 바꿔 11개 spec 을 흡수).
 */

/**
 * 폴더를 경로로 연다 — v5 에서 경로 입력칸은 **설정 시트 > 고급** 한 곳뿐이다(그대로 유지).
 * 여는 길은 제목줄의 ⚙ 다(왼쪽 사이드바가 없다).
 */
export async function openProjectP3(page: Page, root: string): Promise<void> {
  await page.getByRole('button', { name: '설정' }).first().click()
  // 시트가 그려진 뒤에 경로 입력칸을 찾는다 — 앱이 켜지자마자 연결 상태를 확인하러
  // 나가면(제목줄 계정 자리) 첫 렌더가 몇 박 늦어질 수 있다.
  await page.waitForSelector('dialog[open]', { timeout: 30_000 })
  const disclosure = page.locator('details:has(input[aria-label="폴더 경로"])')
  await expect(disclosure).toHaveCount(1)
  await disclosure.first().evaluate((d) => { (d as HTMLDetailsElement).open = true })
  await page.fill('input[aria-label="폴더 경로"]', root)
  await page.click('button:has-text("경로로 열기")')
  // 열리면 설정 시트가 닫히고 작업 공간이 남는다(store/project.ts open → closeSheet).
  await page.waitForSelector('.titlebar', { timeout: 30_000 })
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 30_000 }).catch(() => {})
}

/** 절 하나를 등록하고 그 절에 본문을 써 넣는다 — "본문이 있는 장"이 하나 생긴다. */
export function addSectionBody(root: string, opts: { id?: string; title?: string; body?: string; expected?: number } = {}): void {
  const id = opts.id ?? 'sec-01'
  const title = opts.title ?? 'Ⅰ. 머리말'
  const body = opts.body ?? '농장A의 재배 면적은 600평이다.'
  mkdirSync(join(root, 'sections'), { recursive: true })
  writeFileSync(join(root, 'sections', `${id}.md`), `# ${title}\n\n<!-- gg:draft:start -->\n${body}\n<!-- gg:draft:end -->\n`, 'utf-8')
  const change = join(root, `change-${id}.json`)
  writeFileSync(change, JSON.stringify({ request_id: `e2e:p3:${id}`, ops: [
    { collection: 'sections', value: { id, title, order: 1, path: `sections/${id}.md`, status: 'drafting' } }
  ] }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(opts.expected ?? 0)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

/** 절 본문을 갈아 끼운다 — 기록이 오르고 "방금 저장된 문단"이 생긴다. */
export function rewriteSection(root: string, opts: { id?: string; body?: string; expected: number }): void {
  const id = opts.id ?? 'sec-01'
  writeFileSync(join(root, 'sections', `${id}.md`), `# Ⅰ. 머리말\n\n<!-- gg:draft:start -->\n${opts.body ?? ''}\n<!-- gg:draft:end -->\n`, 'utf-8')
  const change = join(root, `change-${id}-rewrite.json`)
  writeFileSync(change, JSON.stringify({ request_id: `e2e:p3:${id}:rw`, ops: [
    { collection: 'sections', value: { id, title: 'Ⅰ. 머리말', order: 1, path: `sections/${id}.md`, status: 'drafting' } }
  ] }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(opts.expected)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

/**
 * 장 하나를 `review_ready` 로 올린다 — "지금"이 3단계(검토본)가 되는 장면을 만든다.
 * 절 상태는 정본이 들고 있으므로 apply 로 올리고, 앱은 2초 감시로 따라온다.
 */
export function markSectionReady(root: string, opts: { id?: string; expected?: number } = {}): void {
  const id = opts.id ?? 'sec-01'
  const change = join(root, `change-${id}-ready.json`)
  writeFileSync(change, JSON.stringify({ request_id: `e2e:p3:${id}:ready`, ops: [
    { collection: 'sections', value: { id, title: 'Ⅰ. 머리말', order: 1, path: `sections/01.md`, status: 'review_ready' } }
  ] }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(opts.expected ?? 1)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

/** 창 크기를 실제로 바꾼다 — 폭 경계는 창 폭이라 `page.setViewportSize` 로는 안 바뀐다. */
export async function setWindowWidth(app: { evaluate: (fn: (args: { BrowserWindow: typeof import('electron').BrowserWindow }, w: number) => void, arg: number) => Promise<unknown> }, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows()[0].setBounds({ width: w }) }, width)
}
