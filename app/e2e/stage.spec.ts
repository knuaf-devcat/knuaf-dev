/**
 * 진행 규칙 — Node 단위 시험(Playwright 가 Electron 없이 돈다).
 *
 * 기대값은 v2 `DESIGN.md` §4-3 의 우선순위 표에서 **독립적으로** 만든 `expectedStage()` 로
 * 계산한다. `derive()` 를 다시 불러 기대값을 만들면 함수가 틀려도 같이 틀려서 시험이
 * 통과한다(발주 ③).
 *
 * 입력 축(곱 = 768, `REPORT-P3A.md` §2 축 표와 같다):
 *   root(2) · connected(2) · depsFailed(2) · hasProject(2) · questions(2)
 *   × sectionState(3: 모두 초안 다 씀 / 일부만 / 등록된 장 없음)
 *   × stale(2) · reviewExport(2: null | 14) · hasDocx(2)  → 2^8 × 3 = 768
 */
import { expect, test } from '@playwright/test'
import { derive, nextAction, stageInputs, type StageInputs, type StageNo, type StageSection } from '../src/shared/stage'
import type { SectionRow, Status } from '../src/shared/types'

const AXES = {
  root: [true, false],
  connected: [true, false],
  depsFailed: [false, true],
  hasProject: [true, false],
  questions: [0, 2],
  sectionState: ['all', 'partial', 'none'] as const,
  stale: [false, true],
  reviewExport: [14, null],
  hasDocx: [true, false]
}

type SectionState = (typeof AXES.sectionState)[number]
interface Combo {
  root: boolean
  connected: boolean
  depsFailed: boolean
  hasProject: boolean
  questions: number
  sectionState: SectionState
  stale: boolean
  reviewExport: number | null
  hasDocx: boolean
}

function allCombos(): Combo[] {
  const out: Combo[] = []
  for (const root of AXES.root)
    for (const connected of AXES.connected)
      for (const depsFailed of AXES.depsFailed)
        for (const hasProject of AXES.hasProject)
          for (const questions of AXES.questions)
            for (const sectionState of AXES.sectionState)
              for (const stale of AXES.stale)
                for (const reviewExport of AXES.reviewExport)
                  for (const hasDocx of AXES.hasDocx)
                    out.push({ root, connected, depsFailed, hasProject, questions, sectionState, stale, reviewExport, hasDocx })
  return out
}

/** v2 §4-3 — 위에서부터 처음 맞는 것 하나. 구현 함수를 부르지 않는 독립 정본이다. */
function expectedStage(c: Combo): StageNo {
  if (!c.root || !c.connected || c.depsFailed) return 1
  if (!c.hasProject || c.questions > 0 || c.sectionState !== 'all') return 2
  if (c.stale) return 4
  if (c.reviewExport === null) return 3
  if (!c.hasDocx) return 4
  return 5
}

/** v5 DESIGN §2 "단추 하나" 표 — 1·2단계는 없음. */
function expectedAction(c: Combo, now: StageNo): string | null {
  if (now === 3) return '검토본 만들기'
  if (now === 4) return c.stale ? '논문 파일 다시 만들기' : '논문 파일 만들기'
  if (now === 5) return '제출 전 점검'
  return null
}

// --- 사이드카가 실제로 돌려주는 모양 -----------------------------------------

function sectionRows(state: SectionState): SectionRow[] {
  const row = (id: string, status: string): SectionRow => ({
    id, title: `${id} 제목`, order: Number(id.replace('sec-', '')), path: `sections/${id}.md`,
    status, revision: 3, draft_hash: 'h', draft_hash_ok: true, claims: 0
  })
  if (state === 'all') return [row('sec-1', 'review_ready'), row('sec-2', 'review_ready'), row('sec-3', 'review_ready')]
  if (state === 'partial') return [row('sec-1', 'review_ready'), row('sec-2', 'drafting'), row('sec-3', 'empty')]
  return []
}

function buildTree(reviewExport: number | null): { revisions: { revision: number; kinds: { kind: string }[] }[] } {
  if (reviewExport === null) return { revisions: [{ revision: 17, kinds: [{ kind: 'docx' }] }] }
  return {
    revisions: [
      { revision: 9, kinds: [{ kind: 'review' }, { kind: 'docx' }] },
      { revision: reviewExport, kinds: [{ kind: 'review' }] }
    ]
  }
}

function artifacts(hasDocx: boolean): { items: { kind: string }[] } {
  return { items: hasDocx ? [{ kind: 'docx' }, { kind: 'md' }] : [{ kind: 'md' }] }
}

function load(stale: boolean): { project: { outputs: Record<string, { stale?: boolean }> } } {
  return { project: { outputs: stale ? { 'out-1': { stale: true } } : { 'out-2': { stale: false } } } }
}

function projectStatus(questions: number): Status {
  return {
    revision: 3, project_id: 'p', checks: [], gate: [],
    completion: { skill_ready: false, guideline_ready: null, professor_approval_pending: false, notice: '', user_finish_pending: [] },
    tasks: Array.from({ length: questions }, (_, i) => ({ id: `task-interview-${i}`, status: 'needs_user' })),
    lanes: {} as Status['lanes'], user_finish_pending: [], counts: {}
  }
}

/** 한 조합을 "사이드카가 돌려준 모양"으로 만들어 변환 함수를 거쳐 입력을 만든다. */
function inputsOf(c: Combo): StageInputs {
  return {
    ...stageInputs(projectStatus(c.questions), sectionRows(c.sectionState), buildTree(c.reviewExport), artifacts(c.hasDocx), load(c.stale)),
    root: c.root, connected: c.connected, depsFailed: c.depsFailed, hasProject: c.hasProject
  }
}

// --- 768조합 -----------------------------------------------------------------

test('768조합 전부 — v2 §4-3 우선순위와 불일치 0', () => {
  const combos = allCombos()
  expect(combos).toHaveLength(768)
  const mismatches = combos
    .map((c) => ({ c, got: derive(inputsOf(c)).now, want: expectedStage(c) }))
    .filter((m) => m.got !== m.want)
    .map((m) => `기대 ${m.want} · 실제 ${m.got} — ${JSON.stringify(m.c)}`)
  expect(mismatches).toEqual([])
})

test('768조합 전부 — 권하는 단추가 "지금"과 어긋나지 않는다', () => {
  const bad: string[] = []
  for (const c of allCombos()) {
    const inputs = inputsOf(c)
    const derived = derive(inputs)
    const action = nextAction(inputs, derived)
    const want = expectedAction(c, derived.now)
    if (want === null && action !== null) bad.push(`단추가 있으면 안 된다 — ${JSON.stringify(c)}`)
    if (want !== null && (action === null || action.stage !== derived.now || action.label !== want))
      bad.push(`단추 "${want}" 기대 · 실제 ${JSON.stringify(action)} — ${JSON.stringify(c)}`)
  }
  expect(bad).toEqual([])
})

test('768조합 전부 — "지금"은 하나이고 그 하나가 파생 사실과 맞는다', () => {
  const bad: string[] = []
  for (const c of allCombos()) {
    const inputs = inputsOf(c)
    const derived = derive(inputs)
    const stages: StageNo[] = [1, 2, 3, 4, 5]
    if (stages.filter((n) => n === derived.now).length !== 1) bad.push(`"지금" 개수 — ${JSON.stringify(c)}`)
    if (derived.sectionsAllReady !== (c.sectionState === 'all')) bad.push(`sectionsAllReady — ${JSON.stringify(c)}`)
    if (derived.hasReview !== (c.reviewExport !== null)) bad.push(`hasReview — ${JSON.stringify(c)}`)
    if (derived.sectionsDone !== sectionRows(c.sectionState).filter((s) => s.status === 'review_ready').length)
      bad.push(`sectionsDone — ${JSON.stringify(c)}`)
    if (derived.writingIndex !== sectionRows(c.sectionState).findIndex((s) => s.status === 'drafting'))
      bad.push(`writingIndex — ${JSON.stringify(c)}`)
  }
  expect(bad).toEqual([])
})

// --- stageInputs 변환 (IMPL-PLAN §4-4) ---------------------------------------

test('검토본 기준은 fs.build_tree 의 build/<N>/review/ 에서 읽는다 — 14', () => {
  const facts = stageInputs(null, [], buildTree(14), { items: [] }, { project: { outputs: {} } })
  expect(facts.reviewExport).toBe(14)
  expect(facts.hasDocx).toBe(false)
  expect(facts.stale).toBe(false)
})

test('검토본이 없으면 reviewExport 는 null 이다', () => {
  expect(stageInputs(null, [], buildTree(null), { items: [] }, null).reviewExport).toBeNull()
  expect(stageInputs(null, [], { revisions: [] }, null, null).reviewExport).toBeNull()
  expect(stageInputs(null, [], null, null, null).reviewExport).toBeNull()
})

test('DOCX 가 있으면 outputs 가 비어 있어도 hasDocx 참 · stale 거짓', () => {
  const facts = stageInputs(null, [], { revisions: [] }, artifacts(true), { project: { outputs: {} } })
  expect(facts.hasDocx).toBe(true)
  expect(facts.stale).toBe(false)
})

test('파일 현재성은 outputs[*].stale 로만 본다 — 없거나 거짓이면 오래된 것이 아니다', () => {
  expect(stageInputs(null, [], null, null, { project: { outputs: { a: { stale: true } } } }).stale).toBe(true)
  expect(stageInputs(null, [], null, null, { project: { outputs: { a: { stale: false }, b: {} } } }).stale).toBe(false)
  expect(stageInputs(null, [], null, null, { project: { outputs: {} } }).stale).toBe(false)
})

test('질문 수는 한글 마무리를 뺀다 (waitingQuestionCount 와 같은 규칙)', () => {
  const finish: Status['user_finish_pending'] = [{ id: 'font_shinmyeongjo', status: 'needs_user', owner: 'user', reason: '글꼴' }]
  const withFinish = projectStatus(1)
  withFinish.tasks = [...withFinish.tasks, { id: 'font_shinmyeongjo', status: 'needs_user' }]
  withFinish.user_finish_pending = finish
  expect(stageInputs(withFinish, [], null, null, null).questions).toBe(1)
  expect(stageInputs(projectStatus(0), [], null, null, null).questions).toBe(0)
  expect(stageInputs(null, [], null, null, null).questions).toBe(0)
})

test('절은 준 순서 그대로 옮기고 제목·상태를 지킨다', () => {
  const facts = stageInputs(null, sectionRows('partial'), null, null, null)
  const want: StageSection[] = [
    { id: 'sec-1', title: 'sec-1 제목', status: 'review_ready' },
    { id: 'sec-2', title: 'sec-2 제목', status: 'drafting' },
    { id: 'sec-3', title: 'sec-3 제목', status: 'empty' }
  ]
  expect(facts.sections).toEqual(want)
  expect(stageInputs(null, [], null, null, null).sections).toEqual([])
})

// --- 변환한 입력이 단계 판정까지 이어지는가 -----------------------------------

test('변환 → 판정: 검토본 14 · DOCX 있음 · 최신 · 다 씀 → 5 (제출 전 점검)', () => {
  const inputs = inputsOf({ root: true, connected: true, depsFailed: false, hasProject: true, questions: 0, sectionState: 'all', stale: false, reviewExport: 14, hasDocx: true })
  const derived = derive(inputs)
  expect(derived.now).toBe(5)
  expect(nextAction(inputs, derived)?.label).toBe('제출 전 점검')
})

test('변환 → 판정: 검토본이 없으면 3 (검토본 만들기)', () => {
  const inputs = inputsOf({ root: true, connected: true, depsFailed: false, hasProject: true, questions: 0, sectionState: 'all', stale: false, reviewExport: null, hasDocx: true })
  const derived = derive(inputs)
  expect(derived.now).toBe(3)
  expect(nextAction(inputs, derived)?.label).toBe('검토본 만들기')
})

test('변환 → 판정: DOCX 가 없으면 4 · 파일이 오래됐으면 다시 만들기', () => {
  const docx없음 = inputsOf({ root: true, connected: true, depsFailed: false, hasProject: true, questions: 0, sectionState: 'all', stale: false, reviewExport: 14, hasDocx: false })
  expect(nextAction(docx없음, derive(docx없음))?.label).toBe('논문 파일 만들기')
  const 오래됨 = inputsOf({ root: true, connected: true, depsFailed: false, hasProject: true, questions: 0, sectionState: 'all', stale: true, reviewExport: 14, hasDocx: true })
  expect(nextAction(오래됨, derive(오래됨))?.label).toBe('논문 파일 다시 만들기')
})

test('변환 → 판정: 질문이 남아 있으면 파일이 오래됐어도 2 이고 단추가 없다', () => {
  const inputs = inputsOf({ root: true, connected: true, depsFailed: false, hasProject: true, questions: 1, sectionState: 'all', stale: true, reviewExport: 14, hasDocx: true })
  const derived = derive(inputs)
  expect(derived.now).toBe(2)
  expect(derived.stale).toBe(true)
  expect(nextAction(inputs, derived)).toBeNull()
})
