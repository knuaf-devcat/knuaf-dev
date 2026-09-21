import { useEffect, useMemo, useState } from 'react'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import { rpc } from '../rpc'
import { Toolbar } from '../components/Toolbar'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { Feedback, type FeedbackKind } from '../components/Feedback'
import { Preview } from '../components/Preview'
import { ProgressPanel } from '../components/ProgressPanel'
import { ResultCard } from '../components/ResultCard'
import { useRunner } from '../components/useRunner'
import { versioned } from './Outputs'
import { ARTIFACTS, CHECKUP, COMPLETION, EMPTY, INDEPENDENT_REVIEW_MISSING, NOT_APPROVAL_NOTE, checkLabel, describeError, formatBytes, relativeTime, type DescribedError } from '../copy'
import type { ArtifactItem, CheckRow, MaterialsData } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'
import type { ReactNode } from 'react'

const KIND_LABEL: Record<string, string> = { docx: 'DOCX', xlsx: 'XLSX', pdf: 'PDF', md: 'MD' }
const PAPER_IN = 'paper-input.json'
const PAPER_MD = 'build/검토전_본문.md'
/** 검토본 export 가 내놓는 병합 본문 — `build/<개정>/review/검토용.md`. */
const REVIEW_MD = /(?:^|\/)review\/[^/]+\.md$/

/** Check rows whose target mentions this file name; fail beats pass, no rows → neutral. */
function CheckBadge({ name, checks }: { name: string; checks: CheckRow[] | null }) {
  const rows = (checks ?? []).filter((c) => c.target.includes(name))
  if (!rows.length) return <Badge label={ARTIFACTS.checkNone} />
  if (rows.some((r) => r.status === 'fail')) return <Badge tone="fail" label={ARTIFACTS.checkFail} />
  if (rows.some((r) => r.status === 'pass')) return <Badge tone="pass" label={ARTIFACTS.checkPass} />
  return <Badge label={ARTIFACTS.checkNone} />
}

type MakeFeedback = { kind: FeedbackKind; title: ReactNode; body?: ReactNode; details?: ReactNode; actions?: ReactNode }

export function Artifacts() {
  const { root, status, setScreen, openSettings, refresh } = useProject(useShallow((s) => ({ root: s.root, status: s.status, setScreen: s.setScreen, openSettings: s.openSettings, refresh: s.refresh })))
  const appendDraft = useChat((s) => s.appendDraft)
  const platform = window.knuaf.platform
  const joinPath = (rel: string) => `${root}${platform === 'win32' ? '\\' : '/'}${rel}`
  const [items, setItems] = useState<ArtifactItem[] | null>(null)
  const [materials, setMaterials] = useState<MaterialsData | null>(null)
  const [hasPaperInput, setHasPaperInput] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [err, setErr] = useState<DescribedError | null>(null)
  const [savedTo, setSavedTo] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<DescribedError | null>(null)
  // 파일 만들기 — 하나의 슬롯에 교체로 뜬다(누적 금지). making은 중복 호출만 막는다.
  const [making, setMaking] = useState<string | null>(null)
  const [makeFb, setMakeFb] = useState<MakeFeedback | null>(null)
  /** Which 고급 도구 preset a failed make-action deep-links to. */
  const [failTool, setFailTool] = useState<string | null>(null)
  const runner = useRunner()

  const load = async () => {
    if (!root) return
    try {
      const r = await rpc.artifacts(root)
      setItems(r.items)
      setSel((s) => (s && r.items.some((i) => i.path === s) ? s : r.items[0]?.path ?? null))
      setErr(null)
    } catch (e) { setErr(describeError(e)) }
    void rpc.materials(root).then(setMaterials).catch(() => {})
    // 도우미의 논문 입력이 있는지만 본다 — 내용은 읽지 않는 존재 확인.
    void window.knuaf.fileExists(root, PAPER_IN).then((r) => setHasPaperInput('result' in r && r.result === true)).catch(() => setHasPaperInput(false))
  }
  useEffect(() => { void load() }, [root])
  const item = useMemo(() => items?.find((i) => i.path === sel) ?? null, [items, sel])
  const missing = !!status?.lanes.content_review.independent_review_missing
  const taken = (p: string) => !!items?.some((i) => i.path === p)
  const hasMdInput = !!items?.some((i) => i.path === PAPER_MD)
  /**
   * 도우미가 실제로 쓰는 길 — 정본의 절을 합친 검토본. 앱이 `build/검토전_본문.md`
   * 한 이름만 인정하던 때에는 Ⅰ~Ⅶ 이 다 쓰이고 검토본까지 나온 뒤에도 버튼이 잠긴 채
   * "도우미가 아직 본문을 준비하지 않았어요"라고 했다(시험주행 발견 17).
   * 개정이 여럿이면 가장 최근 것을 쓴다.
   */
  const reviewMd = useMemo(() => (items ?? [])
    .filter((i) => i.kind === 'md' && REVIEW_MD.test(i.path))
    .sort((a, b) => (b.revision ?? -1) - (a.revision ?? -1) || b.mtime - a.mtime)[0]?.path ?? null, [items])
  const financeReady = !!materials?.current_finance.provided
  if (!root) return null

  const saveAs = async (it: ArtifactItem) => {
    setSavedTo(null); setSaveErr(null)
    const r = await window.knuaf.fileSaveAs(root, it.path)
    if (r.error) setSaveErr(describeError(r.error))
    else if (r.result) setSavedTo(String(r.result))
  }

  /** SKILL.md:34 / Q1 — the notice is the first line of both the attempt and the result.
   *  INDEPENDENT_REVIEW_MISSING.body is two sentences; the mockup (03-화면/09) puts the first
   *  in the title and the second as the body's first line. */
  const [noticeFirst, noticeRest] = INDEPENDENT_REVIEW_MISSING.body.split(/(?<=.)\. /)
  const noticeTitle = `${INDEPENDENT_REVIEW_MISSING.title} — ${noticeFirst}`

  const tellHelper = (lines: string) => { appendDraft(lines); setScreen('chat') }

  const doExport = async (kind: 'review' | 'submission_candidate') => {
    if (making || runner.busy) return
    setMaking(kind); setMakeFb(null)
    // 시도 시점의 첫 줄: 독립검토 미실행 고지(버튼은 항상 활성 — 경고가 관문, 잠금이 아님).
    if (missing) setMakeFb({ kind: 'warning', title: noticeTitle, body: noticeRest })
    try {
      const r = await rpc.export(root, kind)
      const unverified = status ? status.gate.filter((g) => g.status !== 'pass' && g.severity === 'error') : []
      setMakeFb(missing ? {
        kind: 'warning',
        title: noticeTitle,
        body: <><div>{noticeRest}</div><div>{COMPLETION.exported}: <code>{r.path}</code></div><div className="caption" style={{ marginTop: 'var(--sp-1)' }}>{NOT_APPROVAL_NOTE}</div></>,
        actions: <button onClick={() => window.knuaf.reveal(r.path)}>{ARTIFACTS.reveal}</button>
      } : {
        kind: 'completion',
        title: COMPLETION.exported,
        body: <><code>{r.path}</code><br /><span className="caption">{NOT_APPROVAL_NOTE}</span></>,
        actions: <button onClick={() => window.knuaf.reveal(r.path)}>{ARTIFACTS.reveal}</button>,
        details: unverified.length > 0 ? <div><div className="caption">아직 통과하지 않은 검사 {unverified.length}건</div><ul>{unverified.slice(0, 12).map((g, i) => <li key={i}><code>{g.check_id}</code> {g.target}: {g.reason}</li>)}{unverified.length > 12 && <li>… 외 {unverified.length - 12}건</li>}</ul></div> : undefined
      })
      await refresh(); await load()
    } catch (e) {
      const d = describeError(e)
      if (kind === 'submission_candidate') {
        // 관문 미충족: 무엇이 필요한지는 문장으로, check id는 자세히 안에(03-화면/09).
        const unmet = (status?.gate ?? []).filter((g) => g.status !== 'pass' && g.severity === 'error')
        const needs = unmet.length ? unmet.map((g) => checkLabel(g.check_id)).filter((v, i, a) => a.indexOf(v) === i) : []
        setMakeFb({
          kind: 'warning',
          title: missing ? noticeTitle : ARTIFACTS.make.gateBlocked,
          body: <>{missing && <div>{noticeRest}</div>}
            <div>{ARTIFACTS.make.gateBlocked}{needs.length ? `: ${needs.join(' · ')}` : '.'}</div></>,
          details: <div><div className="caption">관문 미충족: {unmet.map((g) => g.check_id).join(' · ') || '—'}</div><code>{d.raw}</code></div>,
          actions: <>
            <button onClick={() => setScreen('checkup')}>점검에서 확인하기</button>
            <button className="quiet" onClick={() => tellHelper(`제출용 파일을 만들려다 관문에서 막혔어요. 다음 항목을 확인하고 도와 주세요.\n\n${unmet.map((g) => `- ${checkLabel(g.check_id)}: ${g.reason}`).join('\n')}`)}>{CHECKUP.actNotify}</button>
          </>
        })
      } else {
        setMakeFb({
          kind: d.kind === 'status' ? 'status' : 'error',
          title: missing ? noticeTitle : d.title,
          body: <>{missing && <div>{noticeRest}</div>}{missing ? <div>{d.title}</div> : null}{d.action && <div>{d.action}</div>}</>,
          details: <code>{d.raw}</code>,
          actions: <button onClick={() => openSettings('tools:export')}>{ARTIFACTS.make.advancedOpen}</button>
        })
      }
    } finally { setMaking(null) }
  }

  const doDocx = async () => {
    if (making || runner.busy) return
    setMaking('docx'); setMakeFb(null)
    // 던져진 오류(RpcFailure)는 runner.err이 다음 렌더에 든다 — 어느 도구로 이어지는지만 기록.
    // 스크립트가 계약을 지키면 block_reason 이 찬다. 안 지키면 이유가 stdout 평문으로
    // 나오는데(build_docx 가 그랬다 — GUI-08), 거기까지 훑어도 없으면 "없다"고 말한다.
    // 제목만 띄우고 끝내면 학생은 왜 안 됐는지 알 길이 없다.
    const lastLine = (t?: string | null) => t?.trim().split('\n').filter(Boolean).at(-1) || undefined
    const fail = (env: { block_reason?: string | null; stderr?: string; stdout?: string } | null, tool: string) => {
      setFailTool(tool)
      if (env) setMakeFb({
        kind: 'error',
        title: '만들기가 끝나지 않았어요',
        body: lastLine(env.block_reason) ?? lastLine(env.stderr) ?? lastLine(env.stdout) ?? ARTIFACTS.make.failNoReason,
        actions: <button onClick={() => openSettings(tool)}>{ARTIFACTS.make.advancedOpen}</button>
      })
    }
    try {
      // 본문 md가 있으면 그대로. 없으면 도우미의 paper-input.json 으로 만들고,
      // 그것도 없으면 검토본을 쓴다 — 학교 양식 입력이 있으면 그쪽이 먼저다.
      let md = PAPER_MD
      if (!hasMdInput && hasPaperInput) {
        setFailTool('tools:paper')
        md = versioned(PAPER_MD, taken)
        const env = await runner.run('paper.generate', { root, input: PAPER_IN, out: md })
        if (!env?.ok) { fail(env, 'tools:paper'); return }
      } else if (!hasMdInput) {
        if (!reviewMd) return   // 버튼이 잠겨 있어 여기까지 오지 않는다
        md = reviewMd
      }
      setFailTool('tools:docx')
      const out = versioned('build/검토전_논문.docx', taken)
      const env = await runner.run('docx.build', { root, in: md, out, font: '신명조' })
      if (!env?.ok) { fail(env, 'tools:docx'); return }
      await refresh(); await load()
    } finally { setMaking(null) }
  }

  return (
    <div>
      <Toolbar title={ARTIFACTS.title} actions={<><button onClick={() => setScreen('checkup')}>{CHECKUP.goto}</button><button onClick={load}>{ARTIFACTS.refresh}</button></>} />
      {/* 저장 지점의 발행 전 고지 — 점검을 거치지 않고 여기로 와도 독립검토 미실행은 보인다. */}
      {missing && <Feedback kind="warning" title={INDEPENDENT_REVIEW_MISSING.title} body={INDEPENDENT_REVIEW_MISSING.body} />}

      {/* 파일 만들기 — 목록 위 한 단, 버튼만(경로 입력 0). 비활성은 "입력이 없어 실행 자체가
          불가능한 경우"뿐; 제출용은 관문이 막혀도 활성 — 누르는 순간이 고지의 자리(06 4단계·Q1·#4). */}
      <div className="card">
        <div className="card-head"><h2>{ARTIFACTS.make.title}</h2></div>
        <div className="make-row"><div className="grow"><div>{ARTIFACTS.make.review}</div><div className="caption">{ARTIFACTS.make.reviewBody}</div></div>
          <button onClick={() => void doExport('review')} disabled={making === 'review'}>{ARTIFACTS.make.review}</button></div>
        <div className="make-row"><div className="grow"><div>{ARTIFACTS.make.docx}</div><div className="caption">{(hasMdInput || reviewMd || hasPaperInput) ? ARTIFACTS.make.docxBody : ARTIFACTS.make.docxNoInput}</div></div>
          <button onClick={() => void doDocx()} disabled={making === 'docx' || !(hasMdInput || reviewMd || hasPaperInput)}>{ARTIFACTS.make.docx}</button></div>
        <div className="make-row"><div className="grow"><div>{ARTIFACTS.make.submit}</div><div className="caption">{ARTIFACTS.make.submitBody}</div></div>
          <button onClick={() => void doExport('submission_candidate')} disabled={making === 'submission_candidate'}>{ARTIFACTS.make.submit}</button></div>
        <div className="make-row"><div className="grow"><div>{ARTIFACTS.make.xlsx}</div><div className="caption">{financeReady ? ARTIFACTS.make.xlsxBody : ARTIFACTS.make.xlsxNoInput}</div></div>
          <button onClick={() => openSettings('tools:excel')} disabled={!financeReady}>{financeReady ? ARTIFACTS.make.xlsxGoto : ARTIFACTS.make.xlsx}</button></div>
      </div>
      {makeFb && <Feedback kind={makeFb.kind} title={makeFb.title} body={makeFb.body} details={makeFb.details} actions={makeFb.actions} />}
      {runner.busy && <ProgressPanel busy={runner.busy} phase={runner.phase} elapsedMs={runner.elapsedMs} lines={runner.lines} onCancel={runner.cancel} />}
      {runner.err && !runner.busy && !makeFb && <Feedback kind="error" title="만들기를 시작하지 못했어요" body={runner.err} details={<code>{runner.err}</code>} actions={failTool ? <button onClick={() => openSettings(failTool)}>{ARTIFACTS.make.advancedOpen}</button> : undefined} />}
      {runner.cancelled && <Feedback kind="status" title={COMPLETION.cancelled} />}
      {runner.env?.ok && !runner.busy && <ResultCard env={runner.env} onReveal={(p) => window.knuaf.reveal(joinPath(p))} onOpen={(p) => window.knuaf.openPath(joinPath(p))} />}

      <h2>{ARTIFACTS.make.madeTitle}</h2>
      {err && <Feedback kind={err.kind} title={err.title} body={err.action} details={<code>{err.raw}</code>} />}
      {items && items.length === 0 && <EmptyState icon="box" title={EMPTY.artifacts.title} body={EMPTY.artifacts.body} />}

      {items && items.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)', gap: 'var(--sp-4)', alignItems: 'start' }}>
          <div className="list artifact-list">
            {items.map((i) => (
              <div key={i.path} className={`item ${sel === i.path ? 'active' : ''}`} onClick={() => setSel(i.path)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSel(i.path) }}>
                <div className="head">
                  <span className="row" style={{ minWidth: 0 }}>
                    <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.path}>{i.name}</strong>
                    <Badge label={KIND_LABEL[i.kind] ?? i.kind} tone="accent" />
                  </span>
                  <CheckBadge name={i.name} checks={status?.checks ?? null} />
                </div>
                <div className="caption">
                  {i.revision != null && <>{i.revision}번째 기록 · </>}
                  {formatBytes(i.bytes)} · {relativeTime(i.mtime * 1000)}
                </div>
                <div className="caption" title={i.path}>{i.path}</div>
              </div>
            ))}
          </div>

          <div className="card">
            {item ? (
              <>
                <div className="card-head">
                  <h2 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.path}>{item.name}</h2>
                  <span className="row">
                    <button onClick={() => void saveAs(item)}>{ARTIFACTS.save}</button>
                    <button onClick={() => window.knuaf.reveal(joinPath(item.path))}>{ARTIFACTS.reveal}</button>
                    <button onClick={() => window.knuaf.openPath(joinPath(item.path))}>{ARTIFACTS.openExternal}</button>
                  </span>
                </div>
                {savedTo && <div style={{ marginBottom: 'var(--sp-3)' }}><Feedback kind="completion" title={ARTIFACTS.savedTo} body={<code>{savedTo}</code>} /></div>}
                {saveErr && <div style={{ marginBottom: 'var(--sp-3)' }}><Feedback kind={saveErr.kind} title={saveErr.title} body={saveErr.action} details={<code>{saveErr.raw}</code>} /></div>}
                <Preview root={root} item={item} items={items} onRendered={load} />
              </>
            ) : (
              <EmptyState icon="doc" title={ARTIFACTS.previewTitle} body="왼쪽 목록에서 파일을 골라 주세요." />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
