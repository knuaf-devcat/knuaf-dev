import { useState } from 'react'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import { Toolbar } from '../components/Toolbar'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { Disclosure } from '../components/Disclosure'
import { Feedback } from '../components/Feedback'
import { Sheet } from '../components/Sheet'
import { Icon } from '../components/Icon'
import { CHECK_TARGET_LABEL, CHECKUP, COLLECTION_LABEL, INDEPENDENT_REVIEW_MISSING, LANE_COPY, USER_FINISH_HOW, USER_FINISH_LABEL, checkLabel, type LaneCopy } from '../copy'
import type { CheckRow, Status, TaskRow, UserFinishItem } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'

const hasHangul = (s: string) => /[가-힣]/.test(s)

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
        <div className="caption">검사 {r.check_id} · 대상 {CHECK_TARGET_LABEL[r.target] ?? r.target}{r.input_revision != null ? ` · 기준: ${r.input_revision}번째 기록` : ''}</div>
        {!hasHangul(r.reason) && <div className="caption">원문 사유: {r.reason}</div>}
        {r.required_for && r.required_for.length > 0 && <div className="caption">필요 대상: {r.required_for.join(', ')}</div>}
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
          <div className="caption">기다리는 항목: {t.missing.join(', ')}</div>
        </Disclosure>
      )}
    </div>
  )
}

/** SKILL.md:34 — the four lanes stay four; this screen groups work, never verdicts. */
export function Checkup() {
  const { status, peek, refresh, loading, error, setScreen } = useProject(useShallow((s) => ({ status: s.status, peek: s.peek, refresh: s.refresh, loading: s.loading, error: s.error, setScreen: s.setScreen })))
  const { appendDraft } = useChat(useShallow((s) => ({ appendDraft: s.appendDraft })))
  const [how, setHow] = useState<UserFinishItem | null>(null)
  // 디스크의 정본이 읽어 둔 것보다 앞서 있으면 그 번호를 보여 준다. 감시 타이머가 곧
  // 읽어 오고, 두 번 잇따라 못 읽으면 오류가 뜬다 — 어느 쪽이든 옛 숫자를 현재라고
  // 말하지 않는다.
  const ahead = status && peek?.revision != null && peek.revision !== status.revision ? peek.revision : null
  /** Queue the request in the chat draft; never sends — the send button stays under the student's finger. */
  const toChat = (text: string) => {
    appendDraft(text)
    setScreen('chat')
  }
  const fixDraft = (r: CheckRow) => toChat(`다음 항목을 확인하고 고쳐 주세요: ${checkLabel(r.check_id)}\n\n검사: ${r.check_id}\n대상: ${r.target}\n사유: ${r.reason}`)
  const notifyDraft = (r: CheckRow) => toChat(`다음 항목이 아직 확인되지 않았어요. 확인할 수 있게 도와 주세요: ${checkLabel(r.check_id)}\n\n검사: ${r.check_id}\n대상: ${r.target}\n사유: ${r.reason}`)
  // needs_evidence만 근거 문구 — 미지 status에 "근거가 없다"는 초안은 앱이 모르는 판정을 단언한다(#6과 같은 유형).
  const notifyTask = (t: TaskRow) => toChat(t.status === 'needs_evidence'
    ? `아직 근거가 없는 항목이 있어요. 근거를 붙여 주세요${t.missing?.length ? `: ${t.missing.join(', ')}` : '.'}`
    : `이 항목이 어떤 상태인지 확인해 주세요${t.missing?.length ? ` (기다리는 항목: ${t.missing.join(', ')})` : ''}`)

  return (
    <div>
      <Toolbar title={CHECKUP.title} sub={status && <Badge changed={ahead != null || undefined} label={ahead != null ? CHECKUP.recordAhead(ahead) : CHECKUP.record(status.revision)} />} actions={<button onClick={() => void refresh()} disabled={loading}><Icon name="refresh" size={16} /> {loading ? '읽는 중…' : '새로고침'}</button>} />
      {error && <Feedback kind={error.kind} title={error.title} body={error.action} details={<code>{error.raw}</code>} />}
      {status && (() => {
        const fixRows = status.checks.filter((r) => r.status === 'fail')
        const passRows = status.checks.filter((r) => r.status === 'pass')
        // Anything not pass/fail stays visibly unconfirmed — never promoted, never hidden.
        const pendingRows = status.checks.filter((r) => r.status !== 'pass' && r.status !== 'fail')
        const finishIds = new Set(status.user_finish_pending.map((u) => u.id))
        // Fail-closed like the checks below: anything that is not "ready" needs the student,
        // so a status the app does not know yet still surfaces instead of vanishing.
        const todoTasks = status.tasks.filter((t) => !finishIds.has(t.id) && t.status !== 'ready')
        const todoCount = todoTasks.length + status.user_finish_pending.length
        const allEmpty = todoCount === 0 && fixRows.length === 0 && pendingRows.length === 0
        return (
          <>
            {allEmpty && <EmptyState icon="done" title={CHECKUP.emptyAll} />}
            {!allEmpty && (
              <>
                <h2>{CHECKUP.todoTitle} <span className="muted num">{todoCount}</span></h2>
                {todoCount === 0 ? <div className="caption">{CHECKUP.emptyTodo}</div> : (
                  <div className="list">
                    {todoTasks.map((t) => <TaskCard key={t.id} t={t} onAct={(tt) => tt.status === 'needs_user' ? setScreen('chat') : notifyTask(tt)} />)}
                    {status.user_finish_pending.map((u) => (
                      <div key={u.id} className="item">
                        <div className="head"><strong>{USER_FINISH_LABEL[u.id] ?? u.id}</strong><button className="quiet" onClick={() => setHow(u)}>{CHECKUP.actHow}</button></div>
                        {u.reason && <div className="reason">{u.reason}</div>}
                      </div>
                    ))}
                  </div>
                )}
                <h2>{CHECKUP.fixTitle} <span className="muted num">{fixRows.length}</span></h2>
                {fixRows.length === 0 ? <div className="caption">{CHECKUP.emptyFix}</div> : (
                  <div className="list">{fixRows.map((r, i) => <CheckCard key={r.check_id + r.target + i} r={r} action={CHECKUP.actFix} onAct={fixDraft} />)}</div>
                )}
                <h2>{CHECKUP.pendingTitle} <span className="muted num">{pendingRows.length}</span></h2>
                {pendingRows.length === 0 ? <div className="caption">{CHECKUP.emptyPending}</div> : (
                  <div className="list">{pendingRows.map((r, i) => <CheckCard key={r.check_id + r.target + i} r={r} action={CHECKUP.actNotify} onAct={notifyDraft} />)}</div>
                )}
              </>
            )}
            {passRows.length > 0 && (
              <Disclosure label={CHECKUP.passedTitle(passRows.length)}>
                <div className="list">{passRows.map((r, i) => (
                  <div key={r.check_id + r.target + i} className="item">
                    <div className="head"><strong>{checkLabel(r.check_id)}</strong><span className="caption">{CHECK_TARGET_LABEL[r.target] ?? r.target}</span></div>
                  </div>
                ))}</div>
              </Disclosure>
            )}
            <h2>{CHECKUP.lanesTitle}</h2>
            <div className="grid-2">
              {LANE_COPY.map((L) => (
                <div key={L.id} className="item">
                  <div className="head"><strong>{L.title}</strong></div>
                  <div className="caption">{laneLine(status, L)}</div>
                </div>
              ))}
            </div>
            {Object.keys(status.counts).some((k) => COLLECTION_LABEL[k]) && (
              <p className="caption" style={{ marginTop: 'var(--sp-4)' }}>{CHECKUP.countsCaption} — {Object.entries(status.counts).filter(([k]) => COLLECTION_LABEL[k]).map(([k, v]) => `${COLLECTION_LABEL[k]} ${v}`).join(' · ')}</p>
            )}
            <p className="caption">{status.completion.notice}</p>
          </>
        )
      })()}
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
