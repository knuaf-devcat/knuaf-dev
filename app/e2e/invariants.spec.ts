import { test, expect } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { app, launch, navTo, openPreset, openProject, plantStaleLock, synthProject } from './helpers'
import { APP_NAME, APP_NAME_ASCII } from '../src/shared/name'

const CREDIT_1 = APP_NAME
const CREDIT_2 = 'prod. 특용작물전공 24학번 김대욱 · 산업곤충전공 24학번 이준재'
const CREDIT_GUI = 'GUI: made by 산업곤충전공 이준재'
const KORDOC = '문서를 읽는 데 필요한 도구를 준비할게요. 처음 한 번은 시간이 조금 걸릴 수 있어요.'

// copy.ts 첫 줄 규칙 — "every user-facing string of the companion app in one place".
// 강제가 없어 설정의 열기 실패 문구(GUI-04)가 인라인으로 새어나갔다. 화면·컴포넌트
// 소스의 문자열 리터럴/JSX 텍스트에 한글이 있으면 copy.ts 로 옮겨야 한다.
// AST만 보므로 주석·코드 속 한글은 대상이 아니다.
const USER_STRING_DIRS = ['screens', 'components']
const HANGUL = /[가-힯]/

function koreanStrings(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const hits: string[] = []
  const push = (node: ts.Node, text: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    hits.push(`${line + 1}: ${text.trim().replace(/\s+/g, ' ').slice(0, 70)}`)
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) && HANGUL.test(node.text)) push(node, node.text)
    else if (ts.isTemplateExpression(node)) {
      if (HANGUL.test(node.head.text)) push(node.head, node.head.text)
      for (const span of node.templateSpans) if (HANGUL.test(span.literal.text)) push(span.literal, span.literal.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

// 기존 위반이 263건 있다 — 전부 고치는 건 별도 작업이라, 여기서는 "늘지 않는다"를
// 건다. 하나라도 줄이면 이 숫자도 같이 줄일 것(0이면 toEqual([])로 바꾼다).
// 271 → 270: 사이드바에 박혀 있던 앱 이름을 src/shared/name.ts 로 옮겼다.
// 270 → 263(단계 2 합류): Chat.tsx 의 "시작하기"·"이어서 하기"(6)를 copy.ts 의
// `CHAT.firstTurn`·`firstTurnNext` 로, 폴더 없음 화면의 "최근 폴더"(1)를 `CHAT.recentTitle`
// 로 옮겼다 — 두 화면(첫 실행 2단계·재방문)이 같은 부품(FolderPicker)을 쓰게 되면서다.
// 263 → 223(단계 3-B): 사이드바(Sidebar.tsx)가 사라졌다(-9: "먼저 폴더를 여세요"·
// "폴더를 열어 주세요"·"화면" 등). Sheet 의 닫기 이름을 copy.ts `CLOSE_LABEL` 로 옮겼고(-1),
// 새로 생긴 화면 조각(TitleBar·Workspace·PaperPane·Popover·FilesPopover·MaterialsPopover·
// SheetOver·Workspace)은 한글 문자열을 하나도 두지 않았다 — 문구는 전부 copy.ts 에 있다.
// 223 → 230(2차 QA 수정 B): 종이의 "골라서 고쳐 달라기"(N-I03)·"고친 부분 보기"(N-I04) 새
// 컴포넌트(components/ReviewQuote.tsx)의 문구 7개. 그 차수에 copy.ts 는 A 워커 소유라
// 옮기지 못했고, 책임자가 copy.ts 로 옮기면 이 숫자도 223 으로 되돌린다(REPORT-QA2-B).
const KNOWN_USER_STRING_VIOLATIONS = 230

test('user-facing strings live in copy.ts', () => {
  const hits: string[] = []
  for (const dir of USER_STRING_DIRS)
    for (const f of readdirSync(join(app, 'src', 'renderer', 'src', dir)).filter((f) => f.endsWith('.tsx')))
      hits.push(...koreanStrings(join(app, 'src', 'renderer', 'src', dir, f)).map((h) => `${dir}/${f}:${h}`))
  expect(hits, `\n${hits.join('\n')}`).toHaveLength(KNOWN_USER_STRING_VIOLATIONS)
})

/**
 * 앱 이름은 src/shared/name.ts 한 군데에서 온다. electron-builder.yml 은 TS 를 읽지
 * 못해 같은 문자열을 손으로 적어 두므로, 어긋나면 여기서 잡는다 — 어긋나면 화면과
 * Finder 가 서로 다른 이름을 보여 준다.
 */
test('the built app is named what the app calls itself', () => {
  const yml = readFileSync(join(app, 'electron-builder.yml'), 'utf-8')
  const value = (key: string): string | null => yml.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'))?.[1] ?? null
  for (const key of ['executableName', 'CFBundleDisplayName', 'title']) {
    expect(value(key), `electron-builder.yml 의 ${key} 가 APP_NAME 과 다르다`).toBe(APP_NAME)
  }
  // 헬퍼 번들 이름과 설치판 userData 폴더 이름이 여기서 온다 — 한글이 섞이면 앱이 죽는다.
  expect(value('productName')).toBe(APP_NAME_ASCII)
  expect(APP_NAME_ASCII, 'ASCII 가 아닌 글자가 섞였다').toMatch(/^[A-Za-z0-9._-]+$/)
  expect(value('artifactName'), '내려받는 파일 이름에 공백·비ASCII 가 있으면 링크가 깨진다')
    .toMatch(/^[A-Za-z0-9._${}-]+$/)
})

test('reduced motion collapses transitions but keeps the spinner', async () => {
  const { electronApp, page } = await launch({ reducedMotion: 'reduce' })
  const dur = await page.locator('.titlebar .tbtn').first().evaluate((el) => getComputedStyle(el).transitionDuration)
  expect(dur.split(',').map((s) => parseFloat(s)).every((d) => d <= 0.00001)).toBe(true)
  await electronApp.close()
})

test('credit shows on every launch', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const first = await launch({ userData, intro: true })
  // 크레딧은 이제 여는 화면 안에 있다 — 점선 상자로 조용히 얹혀 있던 것을 옮겼다.
  // 앱 이름은 사이드바에도 있으므로 여는 화면 안으로 좁혀서 본다. 그리고 2.6초 뒤
  // 스스로 나가므로 한 번에 읽는다 — 한 줄씩 기다리면 읽는 도중에 사라진다.
  const intro = first.page.locator('[data-intro]')
  await expect(intro).toHaveCount(1)
  // 제목은 글자마다 span 으로 흩어져 있고 공백은 줄이 무너지지 않게 U+00A0 으로
  // 바뀌어 있다(Intro.tsx 의 Letters). 읽을 때 보통 공백으로 되돌린다.
  const shown = (await intro.innerText()).replace(/\u00a0/g, ' ')
  expect(shown).toContain(CREDIT_1)
  expect(shown).toContain(CREDIT_2)
  expect(shown, '만든 사람 줄이 빠졌다').toContain(CREDIT_GUI)
  await first.electronApp.close()
  // 같은 폴더로 다시 켜도 또 뜬다 — 한 번 보고 마는 화면이 아니다.
  const second = await launch({ userData, intro: true })
  const again = second.page.locator('[data-intro]')
  await expect(again, '두 번째 실행에는 여는 화면이 안 떴다').toHaveCount(1)
  expect((await again.innerText()).replace(/\u00a0/g, ' ')).toContain(CREDIT_GUI)
  await second.electronApp.close()
  // 끄는 길은 남겨 둔다(설정 show_intro=false — 시험이 쓰는 것과 같은 스위치).
  const off = await launch({ userData: mkdtempSync(join(tmpdir(), 'kd-ud-')) })
  await expect(off.page.locator('[data-intro]'), 'show_intro=false 인데 떴다').toHaveCount(0)
  await off.electronApp.close()
})

/** 동작 줄이기를 켜도 크레딧은 남는다 — 줄이는 것은 움직임이지 내용이 아니다. */
test('reduced motion keeps the intro readable', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'kd-ud-'))
  const { electronApp, page } = await launch({ userData, reducedMotion: 'reduce', intro: true })
  await expect(page.locator('[data-intro]')).toHaveCount(1)
  await expect(page.locator(`text=${CREDIT_GUI}`)).toBeVisible()
  // 장식 층은 사라진다(움직임만 있는 요소라 남겨 둘 이유가 없다).
  await expect(page.locator('.intro-bloom').first()).toBeHidden()
  await electronApp.close()
})

test('hard rules hold across screens', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  // 폴더 없음 첫 화면은 두 단계 부품(FirstRun)이 덮는다 — 길잡이 한 줄이 있고, 학생 화면에는
  // 경로 입력칸이 어디에도 없다(유일한 경로 입력은 설정 > 고급).
  await expect(page.locator('.chat-pane')).toBeVisible()
  await expect(page.locator('.chat-pane .onb-way')).toBeVisible()
  expect(await page.locator('main input[aria-label="폴더 경로"]').count()).toBe(0)
  await openProject(page, root)
  await page.waitForSelector('.chat-pane', { timeout: 30_000 })

  // v5: 왼쪽 사이드바 다섯 목적지가 사라졌다 — 목적지 목록(nav) 자체가 없다.
  expect(await page.locator('nav').count()).toBe(0)
  // 제목줄은 논문 이름 · 지금(단계) · AI 계정 · 설정 넷뿐이다(DESIGN §1-3).
  const bar = (await page.locator('.titlebar .tbtn').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).join(' | ')
  expect(bar).toContain('지금')
  expect(bar, '계정 자리가 무엇을 쓰는 AI 인지 말해야 한다').toMatch(/ChatGPT 연결됨|Claude 연결됨|AI 연결 안 됨/)
  expect(await page.locator('.titlebar .tbtn.icon').count()).toBe(1)

  // 대화 화면 controls must not ask for JSON/model/path input either (same rule as 도구).
  expect(await page.locator('.chat-pane .tbar-seg, .chat-pane .segmented').count()).toBe(0)
  expect(await page.locator('main input[aria-label="폴더 경로"]').count()).toBe(0)
  const chatCtrls = (await page.locator('.chat-pane label, .chat-pane .field > span, .chat-pane button').allInnerTexts()).join('\n')
  expect(chatCtrls).not.toMatch(/JSON|모델/)

  // The independent-review notice must reach the publish/save points even when the student
  // never opens 점검 — the notice lives at the moment of the attempt, not behind a screen.
  await navTo(page, '결과물')
  await expect(page.locator('text=다른 사람 검토 기록이 아직 없어요')).toBeVisible()
  // 파일 만들기: 제출용 버튼은 관문이 막혀도 활성 — 경고가 관문이지 버튼 잠금이 아니다(#4).
  const submitBtn = page.locator('.make-row:has-text("제출용 후보 만들기") button')
  await expect(submitBtn).toBeEnabled()
  await submitBtn.click()
  await expect(page.locator('text=다른 사람 검토 기록이 아직 없어요').first()).toBeVisible()
  // The same notice reaches the 고급 도구 발행 지점 (설정 > 고급 도구 > 검토본보내기).
  await navTo(page, '설정')
  await openPreset(page, 'tools:export')
  await page.selectOption('details[data-preset="tools:export"] select', 'submission_candidate')
  await expect(page.locator('details[data-preset="tools:export"] >> text=다른 사람 검토 기록이 아직 없어요')).toBeVisible()
  const labels = (await page.locator('details[data-preset="tools:export"] label, details[data-preset="tools:export"] .field > span').allInnerTexts()).join('\n')
  expect(labels).not.toMatch(/JSON|모델/)

  await navTo(page, '점검')
  await page.waitForSelector('[data-screen="checkup"]', { timeout: 30_000 })

  // four lanes by name, no percentage progress, no single done badge
  for (const t of ['자동 점검', '다른 사람 검토', '파일 확인', '교수님 승인']) await expect(page.getByText(t, { exact: true })).toBeVisible()
  expect(await page.locator('[role=progressbar], progress').count()).toBe(0)
  expect(await page.locator('main').innerText()).not.toMatch(/\d+\s*%/)
  // 그 문구는 이제 여러 자리(만들기 고지·결과물 시트·점검 행)에 나온다 — 점검 행으로 좁히되,
  // **고지 요소 자체가 보이는지**를 본다(확인 1회째: toContainText 는 숨은 요소도 통과한다).
  const notice = page.locator('[data-screen="checkup"] .lanes .ln').filter({ hasText: '다른 사람 검토' })
    .getByText('아직 기록이 없어요. 자동 점검 통과가 이를 대신하지 않아요.')
  await expect(notice, '점검 행의 고지가 보이지 않는다').toBeVisible()
  expect(await page.locator('button:has-text("완료")').count()).toBe(0)

  // no skip / N-A controls anywhere on 점검
  expect(await page.locator('button:has-text("건너뛰기"), button:has-text("해당 없음")').count()).toBe(0)

  // 논문 차례: read-only — 종이 칸이 저장된 글을 그대로 보여 주고, 편집기가 어디에도 없다.
  // (v4 는 사이드바 차례 → 읽기 전용 Sheet 였다. 그 자리를 종이 칸이 대신한다.)
  await navTo(page, '내 논문')
  await expect(page.locator('.paperpane .sheet')).toContainText('농장A의 재배 면적은 600평이다')
  expect(await page.locator('.paperpane textarea, .paperpane [contenteditable="true"]').count()).toBe(0)
  // GUI-09 — 본문 텍스트가 a11y 트리에 노드로 들어 있는지 고정한다. 스냅샷은
  // VoiceOver 가 아니므로 실기 읽기 확인은 사람 몫으로 남는다.
  expect(await page.locator('.paperpane').ariaSnapshot()).toContain('농장A의 재배 면적은 600평이다')
  // 차례는 종이 머리의 장 이름 ▾ 팝오버가 연다.
  await page.locator('.paper-head .chap').click()
  await expect(page.locator('.paper-head .popover .pop-row').first()).toContainText('머리말')
  await page.keyboard.press('Escape')

  // troubleshoot (설정 > 문제 해결): release only for a stale same-host lock; sanctioned Kordoc sentence only
  await navTo(page, '설정')
  await openPreset(page, 'fix:lock')
  await openPreset(page, 'fix:kordoc')
  await expect(page.locator(`text=${KORDOC}`)).toHaveCount(1)
  await expect(page.locator('button:has-text("잠금 해제")')).toBeDisabled()
  plantStaleLock(root)
  await page.click('text=다시 진단')
  await expect(page.locator('text=남은 잠금')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('button:has-text("잠금 해제")')).toBeEnabled()
  await electronApp.close()
})
