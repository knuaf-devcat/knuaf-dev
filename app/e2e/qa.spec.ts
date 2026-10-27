/**
 * 시안 대조 QA 수정 묶음 — 발주 ORDER-QA 의 새 시험 셋.
 *
 *   1. 입력칸 모양(원형 단추 2개·테두리 없는 입력·모델 칩·아래 안내문) — 발주 I-01/I-02/R-01/R-02
 *   2. 경고 상자 바탕이 호박이 아니라 아이스 그레이(계산된 배경색) — 발주 황토색 경고 교체
 *   3. 재실행 첫 화면 = 시안 ② 논문 폴더 화면(같은 부품·620px 가운데, 자동 열기 없음) — 형님 결정
 *
 * 전부 숨김 실행이다(`launch()` 가 `KNUAF_E2E_HIDDEN=1` 을 켠다). 연결이 필요하면 가짜
 * `codex app-server`(fixtures)로 고정한다 — 개발 기계의 진짜 CLI 와 무관하게 같은 장면이 되게.
 */
import { expect, test } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'
import { fakeCodexEnv, scratch, writeFakeClaude } from './fixtures/fake-codex'
import { CHAT } from '../src/renderer/src/copy'

test('입력칸은 시안 P/L 대로 — 원형 + · 원형 보내기 · 테두리 없는 입력', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    const box = page.locator('.chat-composer')
    await expect(box).toBeVisible({ timeout: 30_000 })

    // 바깥 상자 — 반경 24px, 얕은 그림자.
    const radius = await box.evaluate((el) => getComputedStyle(el).borderRadius)
    expect(radius).toBe('24px')
    expect(await box.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')

    // 안쪽 입력은 테두리·크기조절 손잡이가 없고 글자 15px.
    const ta = box.locator('textarea')
    await expect(ta).toBeVisible()
    expect(await ta.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')
    expect(await ta.evaluate((el) => getComputedStyle(el).resize)).toBe('none')
    expect(await ta.evaluate((el) => getComputedStyle(el).fontSize)).toBe('15px')

    // 조작부: 원형 `+` 하나, 원형 보내기 하나.
    const circ = box.locator('button.circ')
    const send = box.locator('button.send')
    await expect(circ).toHaveCount(1)
    await expect(send).toHaveCount(1)
    expect(await circ.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%')
    expect(await send.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%')
    // 보내기 자리 이름은 화면 낭독용 aria-label 이 갖는다(아이콘 단추).
    await expect(send).toHaveAttribute('aria-label', CHAT.send)

    // 입력칸 아래 8px, 가운데, 11.5px 안내문.
    const disc = page.locator('.chat-zone .disc')
    await expect(disc).toContainText('도우미도 틀릴 수 있어요')
    expect(await disc.evaluate((el) => getComputedStyle(el).textAlign)).toBe('center')
    expect(await disc.evaluate((el) => getComputedStyle(el).fontSize)).toBe('11.5px')
  } finally {
    await electronApp.close()
  }
})

test('경고 상자 바탕은 호박이 아니라 아이스 그레이(허락 카드와 같은 계열)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await navTo(page, '결과물')
    const fb = page.locator('.feedback.warning').first()
    await expect(fb).toBeVisible({ timeout: 20_000 })
    // 계산된 배경색을 `--alert-bg`(아이스 그레이)와 견준다 — 토큰을 그대로 프로브로 재서
    // 테마가 바뀌어도 같은 규칙을 본다. 호박 바탕(`--warn-soft`)이면 여기서 걸린다.
    const { got, want } = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.background = 'var(--alert-bg)'
      document.body.appendChild(probe)
      const want = getComputedStyle(probe).backgroundColor
      probe.remove()
      const el = document.querySelector('.feedback.warning') as HTMLElement
      return { got: getComputedStyle(el).backgroundColor, want }
    })
    expect(got, '경고 상자 바탕이 아이스 그레이가 아니다').toBe(want)
  } finally {
    await electronApp.close()
  }
})

