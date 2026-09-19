// Personal-use E2E: drive a whole thesis run through the embedded Claude terminal.
// A canned fake farm profile is injected once, then a driver loop keeps answering until
// real artifacts (docx/xlsx/pdf) land under build/ or the budget runs out.
// Sonnet via KNUAF_TERM_MODEL. Costs real subscription usage — deliberate manual run.
import { expect, test } from '@playwright/test'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'

test.setTimeout(45 * 60_000)

const BRIEF = '새 창업논문을 시작해. 아래는 임의의 가상 정보야 — 이걸 그대로 써서 진행해줘. 농장명: 푸른들딸기농장, 대표: 김농부(1988년생), 소재지: 전북 정읍시 북면, 작목: 딸기(설향) 시설재배, 재배면적: 1,320평(비닐하우스 3동 신축 예정), 2024년 귀농·영농교육 100시간 이수, 창업자금: 자기자본 6천만원 + 융자 1억4천만원(농신보 보증), 시설: 관수·양액·보온 시설 포함, 판로: 로컬푸드 직매장 60%·온라인 30%·체험 10%, 연매출 목표 1억2천만원(3년차), 노동: 가족 2명 + 성수기 단기 2명. 모르는 값은 미정으로 기록하고, 추가 질문 없이 가능한 범위에서 작성을 진행해줘.'

const artifacts = (root: string): string[] => {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(docx|xlsx|pdf)$/i.test(name)) out.push(p)
      } catch { /* transient */ }
    }
  }
  walk(join(root, 'build'))
  return out
}

test('full thesis run on claude terminal', async () => {
  const root = synthProject({ withContent: false }) // revision 0 → "시작하기"
  const { electronApp, page } = await launch({ env: { KNUAF_TERM_MODEL: 'sonnet' } })
  const log: string[] = []
  try {
    await openProject(page, root)
    await page.click('button[role="tab"]:has-text("Claude (터미널)")')
    await expect(page.locator('.term-host .xterm')).toBeVisible()

    const replay = async () => {
      const list = await page.evaluate(async (r) => {
        const x = await window.knuaf.term.list(r); return 'result' in x ? x.result : []
      }, root)
      const id = list.find((t: any) => t.kind === 'claude')?.id
      if (!id) return ''
      const r = await page.evaluate(async (i) => {
        const x = await window.knuaf.term.replay(i); return 'result' in x ? x.result : ''
      }, id)
      return r
    }

    // wait for the first turn to settle (skill loaded, first question shown)
    await expect.poll(async () => (await replay()).length, { timeout: 60_000, intervals: [3000] }).toBeGreaterThan(0)
    let last = '', stable = 0
    for (let i = 0; i < 90; i++) { const r = await replay(); if (r === last) stable += 2000; else { stable = 0; last = r }; if (stable >= 12_000) break; await page.waitForTimeout(2000) }
    await page.screenshot({ path: 'e2e/artifacts/thesis-q1.png' })
    log.push('=== first settle ===\n' + last.slice(-800))

    // inject the profile as one line
    await page.click('.term-host')
    await page.keyboard.type(BRIEF)
    await page.keyboard.press('Enter')

    // driver loop: settle → heuristic reply, until artifacts appear or budget ends
    const deadline = Date.now() + 35 * 60_000
    let replies = 0
    while (Date.now() < deadline && replies < 30) {
      let buf = last, calm = 0
      for (let i = 0; i < 150 && Date.now() < deadline; i++) {
        const r = await replay()
        if (r === buf) { calm += 2000; if (calm >= 15_000) break } else { calm = 0; buf = r }
        await page.waitForTimeout(2000)
      }
      last = buf
      const found = artifacts(root)
      if (found.length > 0) { log.push('artifacts found: ' + found.join(', ')); break }
      const tail = buf.slice(-600)
      let reply: string
      if (/1\.\s.*2\.\s/s.test(tail)) reply = '1번으로 진행해줘'
      else if (/\?\s*$/.test(tail) || tail.includes('알려주') || tail.includes('확인')) reply = '위에 알려준 가상 정보로 확정하고, 모르는 건 미정으로 기록해서 계속 진행해줘'
      else reply = '계속 진행해줘'
      await page.click('.term-host'); await page.keyboard.type(reply); await page.keyboard.press('Enter')
      replies++
      log.push(`--- reply ${replies}: ${reply}\ntail: ${tail.slice(-300)}`)
    }
    await page.screenshot({ path: 'e2e/artifacts/thesis-end.png' })

    // artifacts + 결과물 screen
    const found = artifacts(root)
    console.log(log.join('\n\n'))
    console.log('ARTIFACTS:', found.join(' | ') || 'none')
    if (found.length) {
      await showArtifactsScreen(page)
    }
    console.log('REPLIES SENT:', replies)

    // The point of the run is that the agent produces something. Without this the
    // test passed after 45 minutes of producing nothing at all.
    expect(replies, '도우미가 한 번도 응답하지 않았다').toBeGreaterThan(0)
    expect(found, '예산 안에 build/ 산출물이 하나도 생기지 않았다').not.toHaveLength(0)
  } finally {
    await electronApp.close()
  }
})

async function showArtifactsScreen(page: any) {
  await page.click('text=결과물')
  await page.waitForTimeout(3000)
  await page.screenshot({ path: 'e2e/artifacts/thesis-artifacts.png' })
}
