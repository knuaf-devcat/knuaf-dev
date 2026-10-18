import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import { rpc } from '../rpc'
import { useRunner, type Runner } from './useRunner'
import { versioned } from '../screens/Outputs'
import { ARTIFACTS, CHECKUP, COMPLETION, INDEPENDENT_REVIEW_MISSING, NOT_APPROVAL_NOTE, checkLabel, describeError } from '../copy'
import type { FeedbackKind } from './Feedback'

const PAPER_IN = 'paper-input.json'
const PAPER_MD = 'build/검토전_본문.md'
/** 검토본 export 가 내놓는 병합 본문 — `build/<개정>/review/검토용.md`. */
const REVIEW_MD = /(?:^|\/)review\/[^/]+\.md$/

export type MakeKind = 'review' | 'docx' | 'submission_candidate' | 'xlsx'

/**
 * 만들기 한 줄. **"지금"이 권하는 행동과 다르다**(검토 R1-01): 여기는 v2 §4-2의 입력
 * 조건대로 언제든 켜진다 — 인터뷰 중(지금 2)에도 Ⅰ·Ⅱ장만으로 검토본을 만들 수 있다.
 */
export interface MakeRow { kind: MakeKind; label: string; body: string; enabled: boolean }

export interface MakeFeedback { kind: FeedbackKind; title: ReactNode; body?: ReactNode; details?: ReactNode; actions?: ReactNode }

export interface Make {
  rows: MakeRow[]
  runner: Runner
  /** 지금 실행 중인 줄 — 같은 것을 두 번 누르지 못하게 한다. */
  making: MakeKind | null
  feedback: MakeFeedback | null
  clearFeedback: () => void
  run: (kind: MakeKind) => Promise<void>
  /** 실패가 가리키는 고급 도구 프리셋(설정 > 고급 도구 딥링크). */
  failedTool: string | null
}

/**
 * 파일 만들기 — 팝오버(⑩⑮)·점검 시트(⑫)·결과물 전체 화면이 **한 코드**를 쓴다
 * (IMPL-PLAN §4-5, 책임자 의견 ④). 세 벌로 두면 어느 하나만 고쳐진다.
 *
 * 실패는 문장으로, 검사 id 는 "자세히" 안에 — 화면에 JSON 이름을 내밀지 않는다(03-화면/09).
 * 여기 조건은 v2 §4-2 그대로라 **인터뷰 중에도** 검토본을 만들 수 있다("지금"이 권하는
 * 단추와는 다른 것이다 — 검토 R1-01).
 */
export function useMake(): Make {
  const { root, status, refresh, openSettings, sections, artifacts, materials } = useProject(useShallow((s) => ({
    root: s.root, status: s.status, refresh: s.refresh, openSettings: s.openSettings,
    sections: s.sections, artifacts: s.artifacts, materials: s.materials
  })))
  const appendDraft = useChat((s) => s.appendDraft)
  const closeSheet = useProject((s) => s.closeSheet)
  const runner = useRunner()
  const [making, setMaking] = useState<MakeKind | null>(null)
  const [feedback, setFeedback] = useState<MakeFeedback | null>(null)
  const [failedTool, setFailedTool] = useState<string | null>(null)
  const [hasPaperInput, setHasPaperInput] = useState(false)

  // 도우미의 논문 입력이 있는지만 본다 — 내용은 읽지 않는 존재 확인.
  useEffect(() => {
    if (!root) return
    void window.knuaf.fileExists(root, PAPER_IN).then((r) => setHasPaperInput('result' in r && r.result === true)).catch(() => setHasPaperInput(false))
  }, [root])

  const hasMdInput = !!artifacts?.some((i) => i.path === PAPER_MD)
  /**
   * 도우미가 실제로 쓰는 길 — 정본의 절을 합친 검토본. 앱이 `build/검토전_본문.md` 한
   * 이름만 인정하던 때에는 Ⅰ~Ⅶ이 다 쓰이고 검토본까지 나온 뒤에도 버튼이 잠긴 채
   * "도우미가 아직 본문을 준비하지 않았어요"라고 했다(시험주행 발견 17).
   */
  const reviewMd = useMemo(() => (artifacts ?? [])
    .filter((i) => i.kind === 'md' && REVIEW_MD.test(i.path))
    .sort((a, b) => (b.revision ?? -1) - (a.revision ?? -1) || b.mtime - a.mtime)[0]?.path ?? null, [artifacts])
  const written = (sections ?? []).filter((s) => (s.draft_chars ?? 0) > 0).length
  const financeReady = !!materials?.current_finance.provided
  const taken = (p: string): boolean => !!artifacts?.some((i) => i.path === p)
  const missingReview = !!status?.lanes.content_review.independent_review_missing

  const rows: MakeRow[] = [
    { kind: 'review', label: ARTIFACTS.make.review, body: ARTIFACTS.make.reviewBody, enabled: !!status && written > 0 },
    {
      kind: 'docx',
      label: ARTIFACTS.make.docx,
      body: (hasMdInput || hasPaperInput) ? ARTIFACTS.make.docxBody : reviewMd ? ARTIFACTS.make.docxBodyOnly : ARTIFACTS.make.docxNoInput,
      enabled: !!status && (hasMdInput || hasPaperInput || !!reviewMd)
    },
    // 제출용은 관문이 막혀도 활성 — 누르는 순간이 고지의 자리다(Q1·#4 기각).
    { kind: 'submission_candidate', label: ARTIFACTS.make.submit, body: ARTIFACTS.make.submitBody, enabled: !!status },
    { kind: 'xlsx', label: ARTIFACTS.make.xlsx, body: financeReady ? ARTIFACTS.make.xlsxBody : ARTIFACTS.make.xlsxNoInput, enabled: financeReady }
  ]

  // SKILL.md:34 / Q1 — 고지는 시도와 결과 양쪽의 첫 줄이다.
  const [noticeFirst, noticeRest] = INDEPENDENT_REVIEW_MISSING.body.split(/(?<=.)\. /)
  const noticeTitle = `${INDEPENDENT_REVIEW_MISSING.title} — ${noticeFirst}`
  const tellHelper = (lines: string): void => { appendDraft(lines); closeSheet() }

  const doExport = useCallback(async (kind: 'review' | 'submission_candidate') => {
    if (!root) return
    setMaking(kind); setFeedback(null)
    // 시도 시점의 첫 줄: 독립검토 미실행 고지(버튼은 항상 활성 — 경고가 관문, 잠금이 아님).
    if (missingReview) setFeedback({ kind: 'warning', title: noticeTitle, body: noticeRest })
    try {
      const r = await rpc.export(root, kind)
      const unverified = status ? status.gate.filter((g) => g.status !== 'pass' && g.severity === 'error') : []
      setFeedback(missingReview
        ? {
          kind: 'warning',
          title: noticeTitle,
          body: <><div>{noticeRest}</div><div>{COMPLETION.exported}: <code>{r.path}</code></div><div className="caption" style={{ marginTop: 'var(--sp-1)' }}>{NOT_APPROVAL_NOTE}</div></>,
          actions: <button onClick={() => window.knuaf.reveal(r.path)}>{ARTIFACTS.reveal}</button>
        }
        : {
          kind: 'completion',
          title: COMPLETION.exported,
          body: <><code>{r.path}</code><br /><span className="caption">{NOT_APPROVAL_NOTE}</span></>,
          actions: <button onClick={() => window.knuaf.reveal(r.path)}>{ARTIFACTS.reveal}</button>,
          details: unverified.length > 0
            ? <div><div className="caption">{ARTIFACTS.make.unverified(unverified.length)}</div><ul>{unverified.slice(0, 12).map((g, i) => <li key={i}><code>{g.check_id}</code> {g.target}: {g.reason}</li>)}{unverified.length > 12 && <li>…</li>}</ul></div>
            : undefined
        })
      await refresh()
    } catch (e) {
      const d = describeError(e)
      if (kind === 'submission_candidate') {
        // 관문 미충족: 무엇이 필요한지는 문장으로, check id 는 자세히 안에(03-화면/09).
        const unmet = (status?.gate ?? []).filter((g) => g.status !== 'pass' && g.severity === 'error')
        const needs = unmet.length ? unmet.map((g) => checkLabel(g.check_id)).filter((v, i, a) => a.indexOf(v) === i) : []
        setFeedback({
          kind: 'warning',
          title: missingReview ? noticeTitle : ARTIFACTS.make.gateBlocked,
          body: <>{missingReview && <div>{noticeRest}</div>}
            <div>{ARTIFACTS.make.gateBlocked}{needs.length ? `: ${needs.join(' · ')}` : '.'}</div></>,
          details: <div><div className="caption">{unmet.map((g) => g.check_id).join(' · ') || '—'}</div><code>{d.raw}</code></div>,
          actions: <>
            <button onClick={() => openSettings('tools:export')}>{ARTIFACTS.make.advancedOpen}</button>
            <button className="quiet" onClick={() => tellHelper(`${ARTIFACTS.make.gateBlocked}\n\n${unmet.map((g) => `- ${checkLabel(g.check_id)}: ${g.reason}`).join('\n')}`)}>{CHECKUP.actNotify}</button>
          </>
        })
      } else {
        setFailedTool('tools:export')
        setFeedback({
          kind: d.kind === 'status' ? 'status' : 'error',
          title: missingReview ? noticeTitle : d.title,
          body: <>{missingReview && <div>{noticeRest}</div>}{missingReview ? <div>{d.title}</div> : null}{d.action && <div>{d.action}</div>}</>,
          details: <code>{d.raw}</code>,
          actions: <button onClick={() => openSettings('tools:export')}>{ARTIFACTS.make.advancedOpen}</button>
        })
      }
    } finally { setMaking(null) }
  }, [root, status, missingReview, noticeTitle, noticeRest, refresh, openSettings])

  const doDocx = useCallback(async () => {
    if (!root) return
    setMaking('docx'); setFeedback(null)
    // 스크립트가 계약을 지키면 block_reason 이 찬다. 안 지키면 이유가 stdout 평문으로
    // 나오는데(build_docx 가 그랬다 — GUI-08), 거기까지 훑어도 없으면 "없다"고 말한다.
    const lastLine = (t?: string | null): string | undefined => t?.trim().split('\n').filter(Boolean).at(-1) || undefined
    const fail = (env: { block_reason?: string | null; stderr?: string; stdout?: string } | null, tool: string): void => {
      if (!env) return
      setFailedTool(tool)
      setFeedback({
        kind: 'error',
        title: ARTIFACTS.make.failTitle,
        body: lastLine(env.block_reason) ?? lastLine(env.stderr) ?? lastLine(env.stdout) ?? ARTIFACTS.make.failNoReason,
        actions: <button onClick={() => openSettings(tool)}>{ARTIFACTS.make.advancedOpen}</button>
      })
    }
    try {
      // 본문 md가 있으면 그대로. 없으면 도우미의 paper-input.json 으로 만들고,
      // 그것도 없으면 검토본을 쓴다 — 학교 양식 입력이 있으면 그쪽이 먼저다.
      let md = PAPER_MD
      if (!hasMdInput && hasPaperInput) {
        setFailedTool('tools:paper')
        md = versioned(PAPER_MD, taken)
        // 검토본이 있으면 그것을 본문으로 넣는다 — 생성기의 골격 대신 학생이 실제로 쓴 장을
        // 싣고, 겉표지·인준서·목차는 생성기가 붙인다.
        const env = await runner.run('paper.generate', { root, input: PAPER_IN, out: md, ...(reviewMd ? { body: reviewMd } : {}) })
        if (!env?.ok) { fail(env, 'tools:paper'); return }
      } else if (!hasMdInput) {
        if (!reviewMd) return   // 버튼이 잠겨 있어 여기까지 오지 않는다
        md = reviewMd
      }
      setFailedTool('tools:docx')
      const out = versioned('build/검토전_논문.docx', taken)
      const env = await runner.run('docx.build', { root, in: md, out, font: '신명조' })
      if (!env?.ok) { fail(env, 'tools:docx'); return }
      await refresh()
    } finally { setMaking(null) }
  }, [root, hasMdInput, hasPaperInput, reviewMd, artifacts, runner, refresh, openSettings])

  const run = useCallback(async (kind: MakeKind): Promise<void> => {
    if (making || runner.busy) return
    if (kind === 'xlsx') { openSettings('tools:excel'); return }
    if (kind === 'docx') { await doDocx(); return }
    await doExport(kind)
  }, [making, runner.busy, doExport, doDocx, openSettings])

  return { rows, runner, making, feedback, clearFeedback: () => setFeedback(null), run, failedTool }
}
