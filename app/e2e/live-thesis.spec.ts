// Personal-use E2E: drive a whole thesis run through the Claude SDK chat.
// A canned fake farm profile is injected once, then a driver loop keeps answering until
// real artifacts (docx/xlsx/pdf) land under build/ or the budget runs out.
// snapshot.state tells us when a turn ends — no replay-buffer scraping or settle
// heuristics like the removed terminal driver needed. Sonnet via KNUAF_CLAUDE_MODEL.
// Costs real subscription usage — deliberate manual run (KNUAF_LIVE=1, `live-*` pattern).
import { expect, test } from '@playwright/test'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import type { ChatSnapshot } from '../src/shared/chat'

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

test('full thesis run on claude chat', async () => {
  const root = synthProject({ withContent: false }) // revision 0 → "시작하기"
  const { electronApp, page } = await launch({ env: { KNUAF_CLAUDE_MODEL: 'sonnet' } })
  const log: string[] = []
  let replies = 0
  const snap = async (): Promise<ChatSnapshot | null> => page.evaluate(async (rt) => {
    const x = await window.knuaf.chat.snapshot(rt, 'claude'); return 'result' in x ? x.result : null
  }, root)
  const send = async (text: string) => page.evaluate(async ([rt, t]) => {
    const x = await window.knuaf.chat.send(rt, 'claude', t, crypto.randomUUID()); return 'error' in x ? x.error.message : null
  }, [root, text] as const)
  try {
    await openProject(page, root)
    await page.waitForSelector('h1:has-text("내 논문")', { timeout: 30_000 })
    // 검증 실행 — 판정 불가한 명령까지 매번 묻게 두면 드라이버가 멈춘다. 임시 폴더를
    // 신뢰 처리하면 canUseTool 이 unjudgeable 명령도 통과시킨다.
    await page.evaluate((r) => window.knuaf.trustProject(r, true), root)

    const st = await page.evaluate(async (r) => {
      const x = await window.knuaf.chat.status(r, 'claude'); return 'result' in x ? x.result : null
    }, root)
    expect(st?.connected, 'Claude 로그인이 필요해요').toBe(true)

    // driver loop: idle 이면 마지막 assistant 발화를 읽고 답한다 — 상태는 추측이 아니라
    // snapshot.state 에 적혀 있다. 종료 조건: build/ 산출물 등장 또는 35분 예산.
    const deadline = Date.now() + 35 * 60_000
    let turns = 0
    await send(BRIEF)
    while (Date.now() < deadline) {
      await expect.poll(async () => {
        const s = await snap()
        if (s?.state === 'error') throw new Error(`도우미 오류: ${s.error}`)
        // 권한 카드는 신뢰 폴더에서 뜨지 않는다 — 그래도 뜨면 진행이 멈추니 드러낸다.
        if (s?.state === 'permission') throw new Error(`권한 카드가 멈춰 있다: ${s.permission?.title}`)
        return s?.state
      }, { timeout: deadline - Date.now() > 0 ? Math.min(deadline - Date.now(), 600_000) : 1_000, intervals: [5000] }).toBe('idle')
      turns++
      const s = await snap()
      const lastAssistant = s!.messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? ''
      log.push(`=== turn ${turns} tail ===\n${lastAssistant.slice(-600)}`)
      if (turns === 1) await page.screenshot({ path: 'e2e/artifacts/thesis-q1.png' })

      const found = artifacts(root)
      if (found.length > 0) { log.push('artifacts found: ' + found.join(', ')); break }
      const tail = lastAssistant.slice(-600)
      const reply = /1\.\s.*2\.\s/s.test(tail) ? '1번으로 진행해줘'
        : /\?\s*$/.test(tail) || tail.includes('알려주') || tail.includes('확인') ? '위에 알려준 가상 정보로 확정하고, 모르는 건 미정으로 기록해서 계속 진행해줘'
        : '계속 진행해줘'
      const err = await send(reply)
      if (err) { log.push('send failed: ' + err); break }
      replies++
      log.push(`--- reply ${replies}: ${reply}`)
    }
    await page.screenshot({ path: 'e2e/artifacts/thesis-end.png' })

    const found = artifacts(root)
    console.log(log.join('\n\n'))
    console.log('ARTIFACTS:', found.join(' | ') || 'none')
    if (found.length) {
      await page.click('text=결과물')
      await page.waitForTimeout(3000)
      await page.screenshot({ path: 'e2e/artifacts/thesis-artifacts.png' })
    }
    console.log('REPLIES SENT:', replies, '| TURNS SETTLED:', turns)

    // 무엇이 없어서 실패했는지를 메시지로 가른다 — 45분 기다린 뒤 "실패"만 보면
    // 원인을 다시 45분 걸려 찾게 된다.
    expect(turns, '도우미가 한 번도 응답을 끝내지 않았다(idle 에 도달한 턴이 없다)').toBeGreaterThan(0)
    expect(replies, '응답은 왔지만 드라이버의 후속 답장이 한 번도 전달되지 않았다').toBeGreaterThan(0)
    expect(found, '응답은 왔지만 예산 안에 build/ 산출물이 하나도 생기지 않았다').not.toHaveLength(0)
  } finally {
    await electronApp.close()
  }
})
