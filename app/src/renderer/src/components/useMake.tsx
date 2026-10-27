import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import { rpc, RpcFailure } from '../rpc'
import type { Envelope } from '../../../shared/types'
import type { RunnerLine, RunnerPhase } from './useRunner'
import { versioned } from '../screens/Outputs'
import { useStage } from './useStage'
import { ARTIFACTS, CHECKUP, COMPLETION, INDEPENDENT_REVIEW_MISSING, NOT_APPROVAL_NOTE, checkLabel, describeError } from '../copy'
import type { FeedbackKind } from './Feedback'

const PAPER_IN = 'paper-input.json'
const PAPER_MD = 'build/검토전_본문.md'
/** 검토본 export 가 내놓는 병합 본문 — `build/<개정>/review/검토용.md`. */
const REVIEW_MD = /(?:^|\/)review\/[^/]+\.md$/
const LINE_CAP = 400

export type MakeKind = 'review' | 'docx' | 'submission_candidate' | 'xlsx'

/**
 * 만들기 한 줄. **"지금"이 권하는 행동과 다르다**(검토 R1-01): 여기는 v2 §4-2의 입력
 * 조건대로 언제든 켜진다 — 인터뷰 중(지금 2)에도 Ⅰ·Ⅱ장만으로 검토본을 만들 수 있다.
 */
export interface MakeRow { kind: MakeKind; label: string; body: string; enabled: boolean }

export interface MakeFeedback { kind: FeedbackKind; title: ReactNode; body?: ReactNode; details?: ReactNode; actions?: ReactNode }

/** 화면이 읽는 진행·결과 — 실행기 자체는 모듈에 있다. */
export interface MakeRunner {
  busy: boolean
  lines: RunnerLine[]
  env: Envelope | null
  err: string | null
  cancelled: boolean
  phase: RunnerPhase | null
  elapsedMs: number
  clientId: string | null
  cancel: () => Promise<void>
  reset: () => void
}

export interface Make {
  rows: MakeRow[]
  runner: MakeRunner
  /** 지금 실행 중인 줄 — 같은 것을 두 번 누르지 못하게 한다. */
  making: MakeKind | null
  feedback: MakeFeedback | null
  /** 그 피드백이 어느 줄에서 났는가. */
  feedbackKind: MakeKind | null
  clearFeedback: () => void
  run: (kind: MakeKind) => Promise<void>
  /** 실패가 가리키는 고급 도구 프리셋(설정 > 고급 도구 딥링크). */
  failedTool: string | null
  /** 마지막 실행이 남긴 결과 — 종이 머리 한 줄이 연다. */
  finish: { ok: boolean; path: string | null }
}

interface MakeState {
  making: MakeKind | null
  feedback: MakeFeedback | null
  /** 그 피드백이 어느 줄에서 났는가 — 팝오버가 그 줄 바로 아래에 그린다. */
  feedbackKind: MakeKind | null
  failedTool: string | null
  hasPaperInput: boolean
  lastOk: boolean
  lastPath: string | null
  busy: boolean
  lines: RunnerLine[]
  env: Envelope | null
  err: string | null
  cancelled: boolean
  phase: RunnerPhase | null
  elapsedMs: number
  clientId: string | null
}

const INITIAL: MakeState = {
  making: null, feedback: null, feedbackKind: null, failedTool: null, hasPaperInput: false, lastOk: false, lastPath: null,
  busy: false, lines: [], env: null, err: null, cancelled: false, phase: null, elapsedMs: 0, clientId: null
}

/**
 * 만들기 실행·진행·결과는 **화면이 아니라 모듈 하나**가 들고 있다(검토 P3-R1-01).
 *
 * v5 에서 진입점이 셋(종이 머리 권하는 단추·파일 팝오버·결과물 시트)으로 늘었는데, 화면마다
 * `useMake()` 를 따로 만들면 한 곳에서 시작한 고지·진행·결과가 다른 곳에서 보이지 않는다 —
 * 검토 재현에서 팝오버로 만든 결과·고지가 어디에도 남지 않았다. 그래서 상태와 실행기를
 * 모듈 수준에 두고 어느 화면이 열려 있든 같은 것을 본다. 한 번에 하나만 돈다(`making`).
 */
const useMakeState = create<MakeState>(() => ({ ...INITIAL }))
const patch = (p: Partial<MakeState>): void => useMakeState.setState(p)

let clock: ReturnType<typeof setInterval> | null = null
let startedAt = 0
let clientRef: string | null = null

/** 사이드카 스크립트 하나를 돌리고 진행을 모듈 상태로 흘린다(useRunner 와 같은 규칙). */
async function runScript(method: string, params: Record<string, unknown>): Promise<Envelope | null> {
  const id = rpc.newClientId()
  clientRef = id
  startedAt = Date.now()
  patch({ busy: true, lines: [], env: null, err: null, cancelled: false, phase: null, elapsedMs: 0, clientId: id })
  clock = setInterval(() => patch({ elapsedMs: Date.now() - startedAt }), 250)
  try {
    const env = await rpc.script(method, params, (event, data) => {
      if (event === 'log') patch({ lines: [...useMakeState.getState().lines.slice(-(LINE_CAP - 1)), data as RunnerLine] })
      else if (event === 'progress') patch({ phase: data as RunnerPhase })
    }, id)
    patch({ env })
    return env
  } catch (e) {
    if (e instanceof RpcFailure && e.code === 'cancelled') patch({ cancelled: true })
    else { const d = describeError(e); patch({ err: `${d.title}${d.action ? ` ${d.action}` : ''}` }) }
    return null
  } finally {
    if (clientRef === id) clientRef = null
    if (clock) { clearInterval(clock); clock = null }
    patch({ busy: false, elapsedMs: Date.now() - startedAt })
  }
}

const runner: MakeRunner = {
  busy: false,
  lines: [],
  env: null,
  err: null,
  cancelled: false,
  phase: null,
  elapsedMs: 0,
  clientId: null,
  cancel: async () => { const id = clientRef; if (id) await rpc.cancel(id) },
  reset: () => { if (!clientRef) patch({ lines: [], env: null, err: null, cancelled: false, phase: null, elapsedMs: 0, clientId: null }) }
}

/**
 * 파일 만들기 — 팝오버(⑩⑮)·점검 시트(⑫)·결과물 전체 화면·종이 머리 권하는 단추가 **한 코드**를
 * 쓴다(IMPL-PLAN §4-5, 책임자 의견 ④). 실행·진행·결과는 모듈 하나가 들고 있어 화면을 옮겨도 이어진다.
 *
 * 실패는 문장으로, 검사 id 는 "자세히" 안에 — 화면에 JSON 이름을 내밀지 않는다(03-화면/09).
 * 여기 조건은 v2 §4-2 그대로라 **인터뷰 중에도** 검토본을 만들 수 있다.
 */
export function useMake(): Make {
  const st = useMakeState()
  const { root, status, refresh, openSettings, sections, artifacts, materials } = useProject(useShallow((s) => ({
    root: s.root, status: s.status, refresh: s.refresh, openSettings: s.openSettings,
    sections: s.sections, artifacts: s.artifacts, materials: s.materials
  })))
  const closeSheet = useProject((s) => s.closeSheet)
  const appendDraft = useChat((s) => s.appendDraft)
  const revision = useProject((s) => s.status?.revision ?? s.peek?.revision ?? null)
  const refreshSeq = useProject((s) => s.refreshSeq)
  const { derived } = useStage()

  /**
   * 표지 입력(paper-input.json)이 있는지 — **정본이 갱신될 때마다** 다시 본다(검토 P3-R1-05).
   * 예전에는 `[root]` 만 봐서, 도우미가 나중에 입력을 준비해도 만들기 조건이 잠긴 채 남았다.
   */
  useEffect(() => {
    if (!root) { patch({ hasPaperInput: false }); return }
    let alive = true
    void window.knuaf.fileExists(root, PAPER_IN)
      .then((r) => { if (alive) patch({ hasPaperInput: 'result' in r && r.result === true }) })
      .catch(() => { if (alive) patch({ hasPaperInput: false }) })
    return () => { alive = false }
  }, [root, revision, refreshSeq])

  const hasMdInput = !!artifacts?.some((i) => i.path === PAPER_MD)
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
      body: (hasMdInput || st.hasPaperInput) ? ARTIFACTS.make.docxBody : reviewMd ? ARTIFACTS.make.docxBodyOnly : ARTIFACTS.make.docxNoInput,
      enabled: !!status && (hasMdInput || st.hasPaperInput || derived.hasReview)
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
    patch({ making: kind, feedback: null, feedbackKind: null, lastOk: false, lastPath: null })
    // 시도 시점의 첫 줄: 독립검토 미실행 고지(버튼은 항상 활성 — 경고가 관문, 잠금이 아님).
    if (missingReview) patch({ feedback: { kind: 'warning', title: noticeTitle, body: noticeRest }, feedbackKind: kind })
    try {
      const r = await rpc.export(root, kind)
      const unverified = status ? status.gate.filter((g) => g.status !== 'pass' && g.severity === 'error') : []
      patch({
        lastOk: true, lastPath: r.path, feedbackKind: kind,
        feedback: missingReview
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
          }
      })
      await refresh()
    } catch (e) {
      const d = describeError(e)
      if (kind === 'submission_candidate') {
        // 관문 미충족: 무엇이 필요한지는 문장으로, check id 는 자세히 안에(03-화면/09).
        const unmet = (status?.gate ?? []).filter((g) => g.status !== 'pass' && g.severity === 'error')
        const needs = unmet.length ? unmet.map((g) => checkLabel(g.check_id)).filter((v, i, a) => a.indexOf(v) === i) : []
        patch({
          feedbackKind: kind,
          feedback: {
            kind: 'warning',
            title: missingReview ? noticeTitle : ARTIFACTS.make.gateBlocked,
            body: <>{missingReview && <div>{noticeRest}</div>}
              <div>{ARTIFACTS.make.gateBlocked}{needs.length ? `: ${needs.join(' · ')}` : '.'}</div></>,
            details: <div><div className="caption">{unmet.map((g) => g.check_id).join(' · ') || '—'}</div><code>{d.raw}</code></div>,
            actions: <>
              <button onClick={() => openSettings('tools:export')}>{ARTIFACTS.make.advancedOpen}</button>
              <button className="quiet" onClick={() => tellHelper(`${ARTIFACTS.make.gateBlocked}\n\n${unmet.map((g) => `- ${checkLabel(g.check_id)}: ${g.reason}`).join('\n')}`)}>{CHECKUP.actNotify}</button>
            </>
          }
        })
      } else {
        patch({
          failedTool: 'tools:export', feedbackKind: kind,
          feedback: {
            kind: d.kind === 'status' ? 'status' : 'error',
            title: missingReview ? noticeTitle : d.title,
            body: <>{missingReview && <div>{noticeRest}</div>}{missingReview ? <div>{d.title}</div> : null}{d.action && <div>{d.action}</div>}</>,
            details: <code>{d.raw}</code>,
            actions: <button onClick={() => openSettings('tools:export')}>{ARTIFACTS.make.advancedOpen}</button>
          }
        })
      }
    } finally { patch({ making: null }) }
  }, [root, status, missingReview, noticeTitle, noticeRest, refresh, openSettings])

  const doDocx = useCallback(async () => {
    if (!root) return
    patch({ making: 'docx', feedback: null, feedbackKind: null, lastOk: false, lastPath: null })
    const lastLine = (t?: string | null): string | undefined => t?.trim().split('\n').filter(Boolean).at(-1) || undefined
    /**
     * 실패를 화면에 남긴다. `env` 가 null 인 경우(스크립트 호출 자체가 실패: 준비 안 됨·시간 초과 등)도
     * **이유를 말한다** — 예전에는 null 을 그냥 돌려보내 두 새 자리에 아무것도 남지 않았다
     * (검토 확인 1회째 반례 ②). 취소는 실패가 아니므로 삼킨다.
     */
    const fail = (env: { block_reason?: string | null; stderr?: string; stdout?: string } | null, tool: string): void => {
      const reason = env
        ? (lastLine(env.block_reason) ?? lastLine(env.stderr) ?? lastLine(env.stdout) ?? ARTIFACTS.make.failNoReason)
        : useMakeState.getState().err
      if (!reason) return
      patch({
        failedTool: tool, feedbackKind: 'docx',
        feedback: {
          kind: 'error',
          title: ARTIFACTS.make.failTitle,
          body: reason,
          actions: <button onClick={() => openSettings(tool)}>{ARTIFACTS.make.advancedOpen}</button>
        }
      })
    }
    try {
      let md = PAPER_MD
      // 표지 정보 없이 검토본만 묶는 길 — 안내(docxBodyOnly)가 "겉표지·목차 없이 본문만"이므로
      // 목차 쪽도 붙이지 않는다(실기기 QA-03: 안내와 달리 첫 쪽이 목차였다).
      let bodyOnly = false
      if (!hasMdInput && st.hasPaperInput) {
        patch({ failedTool: 'tools:paper' })
        md = versioned(PAPER_MD, taken)
        const env = await runScript('paper.generate', { root, input: PAPER_IN, out: md, ...(reviewMd ? { body: reviewMd } : {}) })
        if (!env?.ok) { fail(env, 'tools:paper'); return }
      } else if (!hasMdInput) {
        if (!reviewMd) return
        md = reviewMd
        bodyOnly = true
      }
      patch({ failedTool: 'tools:docx' })
      const out = versioned('build/검토전_논문.docx', taken)
      const env = await runScript('docx.build', { root, in: md, out, font: '신명조', ...(bodyOnly ? { no_toc: true } : {}) })
      if (!env?.ok) { fail(env, 'tools:docx'); return }
      // 성공도 같은 자리에 남긴다 — 결과 한 줄 + 폴더에서 보기(검토 확인 1회째 반례 ③).
      const path = env.path ?? out
      patch({
        lastOk: true, lastPath: path, feedbackKind: 'docx',
        feedback: {
          kind: 'completion',
          title: COMPLETION.docx_built,
          body: <code>{path}</code>,
          actions: <button onClick={() => window.knuaf.reveal(path)}>{ARTIFACTS.reveal}</button>
        }
      })
      await refresh()
    } finally { patch({ making: null }) }
  }, [root, hasMdInput, st.hasPaperInput, reviewMd, refresh, openSettings])

  const run = useCallback(async (kind: MakeKind): Promise<void> => {
    const s = useMakeState.getState()
    if (s.making || s.busy) return
    if (kind === 'xlsx') { openSettings('tools:excel'); return }
    if (kind === 'docx') { await doDocx(); return }
    await doExport(kind)
  }, [doExport, doDocx, openSettings])

  // 진행·결과 필드는 모듈 상태에서 읽는다(화면이 바뀌어도 같은 값).
  const live: MakeRunner = { ...runner, ...st }
  return {
    rows,
    runner: live,
    making: st.making,
    feedback: st.feedback,
    feedbackKind: st.feedbackKind,
    clearFeedback: () => patch({ feedback: null, feedbackKind: null }),
    run,
    failedTool: st.failedTool,
    finish: { ok: st.lastOk, path: st.lastPath }
  }
}
