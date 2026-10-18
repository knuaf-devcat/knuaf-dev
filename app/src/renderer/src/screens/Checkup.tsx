import { useState } from 'react'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import { Disclosure } from '../components/Disclosure'
import { Feedback } from '../components/Feedback'
import { Sheet } from '../components/Sheet'
import { ProgressPanel } from '../components/ProgressPanel'
import { ResultCard } from '../components/ResultCard'
import { useMake } from '../components/useMake'
import { Icon } from '../components/Icon'
import { ARTIFACTS, CHECK_TARGET_LABEL, CHECKUP, COLLECTION_LABEL, INDEPENDENT_REVIEW_MISSING, LANE_COPY, USER_FINISH_HOW, USER_FINISH_LABEL, checkLabel, fileStatusText, type LaneCopy } from '../copy'
import { joinPath } from '../paths'
import type { CheckRow, Status, TaskRow, UserFinishItem } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'

const hasHangul = (s: string): boolean => /[가-힣]/.test(s)

/**
 * One check row as a card. The title is a status-neutral label (CHECK_LABEL); the badge column
 * is replaced by the section the card sits in (고칠 곳 = fail, 아직 확인 못 한 것 = the rest).
 * Raw id/target/reason live inside 자세히; the reason shows on the card only when it is Korean.
 */
function CheckCard({ r, action, onAct }: { r: CheckRow; action: string; onAct: (r: CheckRow) => void }) {
  return (
    <div className="item">
      <div className="head"><strong>{checkLabel(r.check_id)}</strong><button className="quiet" onClick={() => onAct(r)}>{action}</button></div>
      {hasHangul(r.reason) && <div className="reason">{r.reason}</div>}
      <Disclosure label={CHECKUP.details}>
        <div className="caption">{r.check_id} · {CHECK_TARGET_LABEL[r.target] ?? r.target}{r.input_revision != null ? ` · ${r.input_revision}` : ''}</div>
        {!hasHangul(r.reason) && <div className="caption">{r.reason}</div>}
        {r.required_for && r.required_for.length > 0 && <div className="caption">{r.required_for.join(', ')}</div>}
        {r.evidence && r.evidence.length > 0 && <pre>{JSON.stringify(r.evidence, null, 2)}</pre>}
      </Disclosure>
    </div>
  )
}

/** Per-lane status line. Text only — lanes never merge into one badge, never a percentage. */
function laneLine(status: Status, L: LaneCopy): string {
  switch (L.id) {
    case 'machine': {
      const m = status.lanes.machine
      if (m.summary.fail > 0) return CHECKUP.laneLines.machineFail(m.summary.fail)
      if (m.summary.blocked > 0) return CHECKUP.laneLines.machineBlocked(m.summary.blocked)
      if (m.ready) return CHECKUP.laneLines.machinePass(m.summary.pass)
      return L.notReadyText ?? ''
    }
    case 'content_review':
      return status.lanes.content_review.independent_review_missing ? INDEPENDENT_REVIEW_MISSING.body : CHECKUP.laneLines.reviewDone
    case 'output_review': {
      const o = status.lanes.output_review
      if (o.summary.total === 0) return CHECKUP.laneLines.fileNone
      if (o.guideline_ready === null) return CHECKUP.laneLines.fileNoGuideline
      return o.guideline_ready ? CHECKUP.laneLines.fileReady : CHECKUP.laneLines.fileNotReady
    }
    case 'professor':
      return status.lanes.professor.recorded ? CHECKUP.laneLines.profRecorded : CHECKUP.laneLines.profNone
  }
}

function TaskCard({ t, onAct }: { t: TaskRow; onAct: (t: TaskRow) => void }) {
  const needsAnswer = t.status === 'needs_user'
  const line = needsAnswer ? CHECKUP.needsUserLine : t.status === 'needs_evidence' ? CHECKUP.needsEvidenceLine : CHECKUP.taskOtherLine
  return (
    <div className="item">
      <div className="head"><strong>{line}</strong><button className="quiet" onClick={() => onAct(t)}>{needsAnswer ? CHECKUP.actAnswer : CHECKUP.actNotify}</button></div>
      {t.reason && hasHangul(t.reason) && <div className="reason">{t.reason}</div>}
      {t.missing && t.missing.length > 0 && (
        <Disclosure label={CHECKUP.details}>
          <div className="caption">{t.missing.join(', ')}</div>
        </Disclosure>
      )}
    </div>
  )
}

/**
 * 제출 전 점검 — 논문 칸(또는 창)을 덮는 한 장 (시안 ⑫, DESIGN §1-1·§4-5).
 *
 * 위에서부터: **제출할 파일** → **한글에서 내가 직접 할 것 N** → **확인 네 가지**.
 * 네 갈래는 합치지 않고 행 네 개로 따로 둔다(SKILL.md:34). 색 카드·완료 배지·퍼센트는 없다.
 * 문구는 옛 점검 화면에서 그대로 옮겼고, 바뀐 것은 배치뿐이다.
 *
 * 고칠 곳·아직 확인 못 한 것·도우미에게 할 말은 자동 점검 행의 **자세히** 안에 들어간다 —
 * 없애지 않는다. 만들기(제출용 후보)는 팝오버·결과물 화면과 같은 `useMake()` 를 쓴다.
 */
export function Checkup() {
  const { status, peek, refresh, loading, error, root } = useProject(useShallow((s) => ({ status: s.status, peek: s.peek, refresh: s.refresh, loading: s.loading, error: s.error, root: s.root })))
  const { appendDraft } = useChat(useShallow((s) => ({ appendDraft: s.appendDraft })))
  const files = useProject((s) => s.artifacts)
  const projectLoad = useProject((s) => s.projectLoad)
  const closeSheet = useProject((s) => s.closeSheet)
  const make = useMake()
  const [how, setHow] = useState<UserFinishItem | null>(null)
  const [copied, setCopied] = useState(false)
  // 디스크의 정본이 읽어 둔 것보다 앞서 있으면 그 번호를 보여 준다 — 옛 숫자를 현재라고
  // 말하지 않는다(감시 타이머가 곧 읽어 온다).
  const ahead = status && peek?.revision != null && peek.revision !== status.revision ? peek.revision : null
  /** Queue the request in the chat draft; never sends — the send button stays under the student's finger. */
  const toChat = (text: string): void => { appendDraft(text); closeSheet() }
  const fixDraft = (r: CheckRow): void => toChat(`${CHECKUP.actFix}: ${checkLabel(r.check_id)}\n\n${r.check_id}\n${r.target}\n${r.reason}`)
  const notifyDraft = (r: CheckRow): void => toChat(`${CHECKUP.actNotify}: ${checkLabel(r.check_id)}\n\n${r.check_id}\n${r.target}\n${r.reason}`)
  // needs_evidence만 근거 문구 — 미지 status에 "근거가 없다"는 초안은 앱이 모르는 판정을 단언한다.
  const notifyTask = (t: TaskRow): void => toChat(t.status === 'needs_evidence'
    ? `${CHECKUP.needsEvidenceLine}${t.missing?.length ? `: ${t.missing.join(', ')}` : ''}`
    : `${CHECKUP.taskOtherLine}${t.missing?.length ? ` (${t.missing.join(', ')})` : ''}`)
  const copyRequest = (): void => {
    const line = `${INDEPENDENT_REVIEW_MISSING.title} — ${INDEPENDENT_REVIEW_MISSING.body}`
    void navigator.clipboard?.writeText(line)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="checkup">
      {error && <Feedback kind={error.kind} title={error.title} body={error.action} details={<code>{error.raw}</code>} />}
      {status && (() => {
        const fixRows = status.checks.filter((r) => r.status === 'fail')
        const pendingRows = status.checks.filter((r) => r.status !== 'pass' && r.status !== 'fail')
        const finishIds = new Set(status.user_finish_pending.map((u) => u.id))
        // Fail-closed like the checks: anything that is not "ready" needs the student,
        // so a status the app does not know yet still surfaces instead of vanishing.
        const todoTasks = status.tasks.filter((t) => !finishIds.has(t.id) && t.status !== 'ready')
        const finished = status.user_finish_pending
        const made = (files ?? []).filter((f) => f.kind === 'docx' || f.kind === 'xlsx')
        const machine = LANE_COPY.find((l) => l.id === 'machine')!
        const content = LANE_COPY.find((l) => l.id === 'content_review')!
        const output = LANE_COPY.find((l) => l.id === 'output_review')!
        const professor = LANE_COPY.find((l) => l.id === 'professor')!
        return (
          <>
            <div className="row between checkup-head">
              <span className="caption">{CHECKUP.head(ahead ?? status.revision)}</span>
              <button className="quiet" onClick={() => void refresh()} disabled={loading}><Icon name="refresh" size={14} /> {CHECKUP.refresh}</button>
            </div>

            <section className="chk">
              <div className="t">{CHECKUP.fileTitle}</div>
              {made.length === 0
                ? <p className="caption">{CHECKUP.fileNone}</p>
                : made.map((f) => (
                  <div key={f.path} className="file">
                    <Icon name="doc" size={14} />
                    <span>{f.name}</span>
                    {/* 파일 팝오버와 **같은** 판정(검토 P3-R1-06) — 등록된 파일은 `outputs[*].stale`,
                        검토본은 그 파일의 개정 번호, 근거가 없는 파일만 '모름'이다. */}
                    <span className="m caption">{fileStatusText(f.path, projectLoad)}</span>
                    {/* 정본 안 상대경로다 — 다른 화면과 **같은** 구분자 규칙(joinPath)을 거친다. */}
                    <button className="quiet" onClick={() => void window.knuaf.openPath(joinPath(root, f.path))}>{ARTIFACTS.openExternal}</button>
                  </div>
                ))}
              <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
                <button className="primary" disabled={make.making !== null} onClick={() => void make.run('submission_candidate')}>{ARTIFACTS.make.submit}</button>
                <span className="caption">{ARTIFACTS.make.submitBody}</span>
              </div>
            </section>

            <section className="chk">
              <div className="t">{CHECKUP.finishTitle} <span className="cnt">{finished.length}</span><span className="who">{CHECKUP.finishWho}</span></div>
              {finished.length === 0
                ? <p className="caption">{CHECKUP.emptyTodo}</p>
                : (
                  <ul>
                    {finished.map((u) => (
                      <li key={u.id}>
                        <span>{USER_FINISH_LABEL[u.id] ?? u.id}</span>
                        <span className="m"><button className="quiet" onClick={() => setHow(u)}>{CHECKUP.actHow}</button></span>
                      </li>
                    ))}
                  </ul>
                )}
            </section>

            <section className="chk">
              <div className="t">{CHECKUP.lanesTitle}<span className="who">{CHECKUP.lanesWho}</span></div>
              <div className="lanes">
                <div className="ln">
                  <b>{machine.title}</b>
                  <span>{laneLine(status, machine)}</span>
                  <Disclosure label={CHECKUP.details}>
                    {todoTasks.length > 0 && <>
                      <div className="caption">{CHECKUP.todoTitle} {todoTasks.length}</div>
                      <div className="list">{todoTasks.map((t) => <TaskCard key={t.id} t={t} onAct={(tt) => tt.status === 'needs_user' ? closeSheet() : notifyTask(tt)} />)}</div>
                    </>}
                    {fixRows.length > 0 && <>
                      <div className="caption">{CHECKUP.fixTitle} {fixRows.length}</div>
                      <div className="list">{fixRows.map((r, i) => <CheckCard key={r.check_id + r.target + i} r={r} action={CHECKUP.actFix} onAct={fixDraft} />)}</div>
                    </>}
                    {pendingRows.length > 0 && <>
                      <div className="caption">{CHECKUP.pendingTitle} {pendingRows.length}</div>
                      <div className="list">{pendingRows.map((r, i) => <CheckCard key={r.check_id + r.target + i} r={r} action={CHECKUP.actNotify} onAct={notifyDraft} />)}</div>
                    </>}
                    {todoTasks.length === 0 && fixRows.length === 0 && pendingRows.length === 0 && <div className="caption">{CHECKUP.emptyAll}</div>}
                  </Disclosure>
                </div>
                <div className="ln">
                  <b>{content.title}</b>
                  <span>{laneLine(status, content)}</span>
                  <button className="quiet" onClick={copyRequest}>{copied ? CHECKUP.copied : CHECKUP.copyRequest}</button>
                </div>
                <div className="ln"><b>{output.title}</b><span>{laneLine(status, output)}</span><span /></div>
                <div className="ln"><b>{professor.title}</b><span>{laneLine(status, professor)}</span><span /></div>
              </div>
            </section>

            {/* 등록 현황·완료 안내는 기술 기록이다 — 기본 화면에 두지 않고 접어 둔다(DESIGN §5 쉬운 말). */}
            <Disclosure label={CHECKUP.recordDetail}>
              {Object.keys(status.counts).some((k) => COLLECTION_LABEL[k]) && (
                <p className="caption">{CHECKUP.countsCaption} — {Object.entries(status.counts).filter(([k]) => COLLECTION_LABEL[k]).map(([k, v]) => `${COLLECTION_LABEL[k]} ${v}`).join(' · ')}</p>
              )}
              <p className="caption">{status.completion.notice}</p>
            </Disclosure>
          </>
        )
      })()}
      {!status && <p className="caption">{ahead != null ? CHECKUP.recordAhead(ahead) : CHECKUP.emptyAll}</p>}

      {make.feedback && <Feedback kind={make.feedback.kind} title={make.feedback.title} body={make.feedback.body} details={make.feedback.details} actions={make.feedback.actions} />}
      {make.runner.busy && <ProgressPanel busy={make.runner.busy} phase={make.runner.phase} elapsedMs={make.runner.elapsedMs} lines={make.runner.lines} onCancel={make.runner.cancel} />}
      {make.runner.env?.ok && !make.runner.busy && <ResultCard env={make.runner.env} onReveal={(p) => window.knuaf.reveal(joinPath(root, p))} onOpen={(p) => window.knuaf.openPath(joinPath(root, p))} />}

      <Sheet open={!!how} title={how ? (USER_FINISH_LABEL[how.id] ?? how.id) : ''} onClose={() => setHow(null)}>
        <p>{how?.reason}</p>
        {how && USER_FINISH_HOW[how.id] && (
          <>
            <ol>{USER_FINISH_HOW[how.id].steps.map((s) => <li key={s}>{s}</li>)}</ol>
            <p className="caption">{USER_FINISH_HOW[how.id].done}</p>
          </>
        )}
        <p className="caption">{CHECKUP.finishHowNote}</p>
      </Sheet>
    </div>
  )
}
