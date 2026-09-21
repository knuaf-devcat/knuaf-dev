import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useProject } from '../store/project'
import { chatProvider, resolveChatMode, useChat, type ChatMode } from '../store/chat'
import { rpc } from '../rpc'
import { Toolbar } from '../components/Toolbar'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { Feedback } from '../components/Feedback'
import { ProjectCard } from '../components/ProjectCard'
import { CHAT, CREDIT, EMPTY, describeChatError, relativeTime } from '../copy'
import type { ChatMessage } from '../../../shared/chat'
import type { ArtifactItem, ProjectPeek, RecentEntry, SectionRow } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'

/** [이름](경로) 한 쌍. 줄바꿈을 넘지 않는다 — 산문 한가운데의 링크만 집는다. */
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g
/** 프로젝트 안 상대경로처럼 생긴 것만. 주소(http:)·절대경로·.. 는 제외한다. */
const INSIDE_PATH = /^(?![/\\]|[a-zA-Z][a-zA-Z0-9+.-]*:)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$)).+$/

/**
 * 도우미 답변의 파일 링크를 누를 수 있게 만든다 — 마크다운 원문이 그대로 보이고
 * 접근성 역할도 일반 텍스트였다(GUI 감사 GUI-12).
 *
 * 경로는 "파일 얘기구나"를 판단하는 데만 쓰고 **절대 열지 않는다**. 도우미가 쓴
 * 문자열을 그대로 여는 순간 답변 텍스트가 곧 실행 권한이 된다. 누르면 결과물 화면으로
 * 갈 뿐이고, 파일에 닿는 일은 앱이 스스로 목록에서 확인한 경로로만 한다.
 * 안쪽 상대경로가 아닌 링크는 원문 그대로 둔다 — 감추지 않는다.
 */
function withLinks(text: string, onGo: () => void): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(LINK)) {
    const [whole, label, target] = m
    if (!INSIDE_PATH.test(target)) continue
    out.push(text.slice(last, m.index))
    out.push(<button key={m.index} className="lk" onClick={onGo}>{label}</button>)
    last = (m.index ?? 0) + whole.length
  }
  if (!out.length) return text
  out.push(text.slice(last))
  return out
}

/**
 * 한 말풍선이 이보다 길면 접는다. 도우미가 도구 보고 원문을 그대로 채팅에 쏟으면
 * (주행에서 20,600자가 들어왔다) 대화가 사람이 지나갈 수 없는 길이가 된다.
 * 내용을 버리지는 않는다 — 펼치면 전문이 그대로 있다.
 */
const LONG_MESSAGE = 2000

function Message({ m, onResend, onGoArtifacts }: { m: ChatMessage; onResend?: () => void; onGoArtifacts?: () => void }) {
  const [open, setOpen] = useState(false)
  if (m.role === 'system') return <div className="chat-msg system"><span className="caption">{m.text}</span></div>
  const long = m.text.length > LONG_MESSAGE
  const shown = long && !open ? m.text.slice(0, LONG_MESSAGE) : m.text
  return (
    <div className={`chat-msg ${m.role}`}>
      <div className="chat-msg-head">
        <span className="chat-who">{m.role === 'user' ? CHAT.me : CHAT.assistant}</span>
        <span className="caption">{relativeTime(m.at)}</span>
        {m.role === 'user' && m.delivery === 'pending' && <Badge tone="warning" label={CHAT.sending} />}
        {m.role === 'user' && m.delivery === 'uncertain' && <Badge tone="fail" label={CHAT.uncertain} />}
      </div>
      <div className="prose">{m.role === 'assistant' && onGoArtifacts ? withLinks(shown, onGoArtifacts) : shown}</div>
      {long && <button className="lk" onClick={() => setOpen(!open)}>{open ? CHAT.showLess : CHAT.showMore(m.text.length - LONG_MESSAGE)}</button>}
      {m.delivery === 'uncertain' && onResend && <button onClick={onResend}>{CHAT.resend}</button>}
    </div>
  )
}

/**
 * 폴더 없음 — "홈"이 아니라 내 논문의 한 상태(03-화면/01). 첫 행동은 폴더 고르기 하나뿐;
 * 경로 입력칸은 없고(설정 > 고급에만), 준비는 여는 순간 백그라운드로 돌아 실패만 표면화된다.
 */
function NoFolder() {
  const { open, settings, error, loading, loadSettings } = useProject(useShallow((s) => ({ open: s.open, settings: s.settings, error: s.error, loading: s.loading, loadSettings: s.loadSettings })))
  const [showCredit, setShowCredit] = useState(false)
  const [peeks, setPeeks] = useState<Record<string, ProjectPeek>>({})
  useEffect(() => {
    if (settings && !settings.credit_shown_at) {
      setShowCredit(true)
      void window.knuaf.setSettings({ credit_shown_at: new Date().toISOString() })
    }
  }, [settings])
  useEffect(() => {
    let alive = true
    void (async () => {
      const out: Record<string, ProjectPeek> = {}
      for (const r of settings?.recent ?? []) out[r.root] = await window.knuaf.peekProject(r.root)
      if (alive) setPeeks(out)
    })()
    return () => { alive = false }
  }, [settings?.recent])
  const pick = async () => { const dir = await window.knuaf.pickFolder(); if (dir) await open(dir) }
  const remove = async (r: string) => { await window.knuaf.setSettings({ recent: (settings?.recent ?? []).filter((x) => x.root !== r) }); await loadSettings() }
  return (
    <div>
      <Toolbar title={CHAT.title} />
      {showCredit && <div className="credit">{CREDIT.line1}<br />{CREDIT.line2}</div>}
      {error && <Feedback kind={error.kind} title={error.title} body={error.action} details={<code>{error.raw}</code>} />}
      <div className="empty" style={{ padding: 'var(--sp-8)' }}>
        <div className="t" style={{ fontSize: 'var(--fs-heading)' }}>{CHAT.noFolderTitle}</div>
        <div>{CHAT.noFolderIntro}</div>
        <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
          <button className="primary" onClick={pick} disabled={loading}>{CHAT.openFolder}</button>
        </div>
        <div className="caption">{loading ? CHAT.opening : CHAT.noFolderBody}</div>
      </div>
      <h2>최근 폴더</h2>
      {(settings?.recent ?? []).length === 0 ? (
        <EmptyState icon="folder" title={EMPTY.recent.title} body={EMPTY.recent.body} />
      ) : (
        <div className="projects stagger">
          {(settings?.recent ?? []).map((r: RecentEntry, i) => {
            const p = peeks[r.root]
            return <ProjectCard key={r.root} index={i} root={r.root} openedAt={relativeTime(r.opened_at)} revision={p?.revision ?? null} exists={p ? p.exists : true} hasProject={p?.hasProject ?? false} onOpen={() => open(r.root)} onRemove={() => remove(r.root)} />
          })}
        </div>
      )}
    </div>
  )
}

/** "내 논문": 도우미와의 대화 — 인터뷰와 작문이 일어나는 곳. 폴더가 없으면 폴더 고르기 상태가 된다. */
export function Chat() {
  const projectRoot = useProject((s) => s.root)
  const settings = useProject((s) => s.settings)
  const loadSettings = useProject((s) => s.loadSettings)
  const pStatus = useProject((s) => s.status)
  const peek = useProject((s) => s.peek)
  const pError = useProject((s) => s.error)
  const clearPError = useProject((s) => s.clearError)
  const setScreen = useProject((s) => s.setScreen)
  const revision = pStatus?.revision ?? peek?.revision ?? null
  const { root, snapshot, status, statusFailed, draft, busy, error, mode, setMode, setDraft, insertPath, clearError, load, refreshStatus, login, send, respond, stop } = useChat(useShallow((s) => ({ root: s.root, snapshot: s.snapshot, status: s.status, statusFailed: s.statusFailed, draft: s.draft, busy: s.busy, error: s.error, mode: s.mode, setMode: s.setMode, setDraft: s.setDraft, insertPath: s.insertPath, clearError: s.clearError, load: s.load, refreshStatus: s.refreshStatus, login: s.login, send: s.send, respond: s.respond, stop: s.stop })))
  const endRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [claudeFound, setClaudeFound] = useState(false)
  const [sections, setSections] = useState<SectionRow[] | null>(null)
  const [lastArtifact, setLastArtifact] = useState<ArtifactItem | null>(null)
  const [copied, setCopied] = useState(false)

  const seg: ChatMode = resolveChatMode(mode, settings)
  const provider = chatProvider(seg)

  // 스냅샷의 provider가 화면 provider와 다르면(설정·시작 버튼으로 모드 전환) 다시 불러온다 —
  // codex 대화가 claude 화면에 남는 식의 혼합은 없어야 한다.
  useEffect(() => { if (projectRoot && (projectRoot !== root || provider !== snapshot?.provider)) void load(projectRoot, provider) }, [projectRoot, root, snapshot?.provider, provider, load])
  /**
   * 예전에는 `.chat-log` 를 스크롤하려 했는데 그 요소에는 overflow 가 없다 — 실제로
   * 흐르는 것은 화면 전체(.main)여서 이 호출은 아무 일도 하지 않았다. 그래서 답변이
   * 길어지면 입력칸은 물론 **권한 카드까지 화면 밖으로 밀렸고**, 학생은 아래쪽의
   * "도우미가 작업 중"만 보고 기다렸다. 실제로는 앱이 학생의 답을 기다리며 멈춰
   * 있었다(시험주행 발견 5).
   *
   * 바닥에 붙어 있을 때만 따라 내려간다 — 위를 읽는 중인 학생의 화면을 빼앗지 않는다.
   * 권한 카드는 예외다. 진행을 막는 것이라 어디를 보고 있든 데려간다.
   */
  const toBottom = (smooth = false) => endRef.current?.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' })
  useEffect(() => {
    const el = endRef.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setAtBottom(e.isIntersecting), { rootMargin: '0px 0px -8px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  // 화면에 들어올 때는 늘 바닥이다 — 다른 메뉴에 갔다 오면 대화 맨 위로 돌아가
  // 답변 입력칸까지 다시 내려가야 했다(시험주행 발견 9).
  useEffect(() => { toBottom() }, [root, snapshot?.provider])
  useEffect(() => { if (atBottom) toBottom() }, [snapshot?.messages.length, snapshot?.state])
  useEffect(() => { if (snapshot?.permission) toBottom() }, [snapshot?.permission?.id])
  useEffect(() => {
    if (!projectRoot) { setClaudeFound(false); return }
    let alive = true
    void window.knuaf.agentStatus(projectRoot)
      .then((r) => { if (alive && r && 'result' in r) setClaudeFound(!!(r.result as { claude?: { found?: boolean } }).claude?.found) })
      .catch(() => {})
    return () => { alive = false }
  }, [projectRoot])
  // 상태 한 줄·활동 카드는 프로젝트 데이터만 쓴다 — 도우미 provider와 무관(03-화면/02 결정).
  useEffect(() => {
    if (!projectRoot) return
    let alive = true
    void rpc.sections(projectRoot).then((s) => { if (alive) setSections(s) }).catch(() => {})
    void rpc.artifacts(projectRoot).then((a) => { if (alive) setLastArtifact(a.items.at(-1) ?? null) }).catch(() => {})
    return () => { alive = false }
  }, [projectRoot, revision])

  const running = snapshot?.state === 'running' || snapshot?.state === 'permission'
  const lastUncertain = snapshot?.messages.filter((m) => m.role === 'user' && m.delivery === 'uncertain').at(-1)
  const attach = async () => { const p = await window.knuaf.pickFile({ title: CHAT.attach }); if (p) insertPath(p) }

  const emptyChat = !!snapshot && snapshot.messages.length === 0
  const hasRevision = (revision ?? 0) >= 1

  /** 시작 버튼이 모드 선택을 겸한다 — 고른 도우미는 helper_mode에 기록(이후 설정에서 변경). */
  const remember = (m: ChatMode) => { setMode(m); void window.knuaf.setSettings({ helper_mode: m }).then(() => loadSettings()) }
  /**
   * 공급자를 고르고 첫 마디를 보낸다. 고르기만 하면 화면이 그대로 멈춘다 —
   * claude 쪽이 remember 만 하고 send 를 안 해서 "눌러도 아무 일이 없는" 상태였다.
   *
   * 공급자가 실제로 바뀔 때는 먼저 load 를 끝내야 한다. :110 의 effect 가 전환을 보고
   * load 를 부르는데 load 는 스냅샷을 비우므로, 바로 send 하면 그 결과가 지워진다.
   * codex 는 기본 공급자라 전환이 없어 이 경합을 겪지 않았을 뿐이다.
   */
  const startWith = async (mode: 'codex-chat' | 'claude-chat', text: string) => {
    const next = chatProvider(mode)
    remember(mode)
    if (projectRoot && next !== provider) await load(projectRoot, next)
    void send(text)
  }
  const startCodex = (text: string) => { void startWith('codex-chat', text) }
  const startClaude = (text: string) => { void startWith('claude-chat', text) }
  const copyDraft = () => {
    void navigator.clipboard?.writeText(draft)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const chatErr = error ? describeChatError(error) : null
  const snapErr = snapshot?.error && snapshot.state !== 'interrupted' && snapshot.state !== 'stopped' ? describeChatError(snapshot.error) : null

  if (!projectRoot) return <NoFolder />

  // 지금 상태 한 줄 — 행동 단위 사실만. 말할 사실이 없으면 그리지 않는다(03-화면/03 결정).
  const failCount = pStatus?.checks.filter((c) => c.status === 'fail').length ?? 0
  // Checkup 과 같은 기준으로 마무리 항목을 빼야 "답변" 수가 진짜 질문 수가 된다.
  const finishIds = new Set(pStatus?.user_finish_pending.map((u) => u.id) ?? [])
  const waitCount = pStatus?.tasks.filter((t) => t.status === 'needs_user' && !finishIds.has(t.id)).length ?? 0
  const finishCount = pStatus?.user_finish_pending.length ?? 0
  const drafting = sections?.find((s) => s.status === 'drafting')
  const statePieces: string[] = []
  if (drafting) statePieces.push(CHAT.statusDrafting(drafting.title))
  if (failCount > 0) statePieces.push(CHAT.statusFix(failCount))
  if (waitCount > 0) statePieces.push(CHAT.statusWait(waitCount))
  if (finishCount > 0) statePieces.push(CHAT.statusFinish(finishCount))

  const lastAssistant = snapshot?.messages.filter((m) => m.role === 'assistant').at(-1)
  const lastAt = snapshot?.messages.at(-1)?.at ?? (lastArtifact ? lastArtifact.mtime * 1000 : null)
  // "방금 한 일"의 제목은 행동·결과여야 한다 — 도우미가 되물은 문장은 제목이 아니라
  // 상태 한 줄의 "내 답변 N건 기다리는 중"이 말한다(06 4단계). 질문이면 결과물 이름으로 넘긴다.
  // 첫 줄이 늘 행동은 아니다 — 도우미 답변은 `> knuaf-doc · …` 머리글로 시작할 때가
  // 있어서, 그대로 집으면 "방금 한 일"이 배너만 되뇌는 빈 카드가 된다(시험주행 발견 4).
  const lastAssistantLine = lastAssistant?.text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('>') && !l.startsWith('#'))
  const actTitle = (lastAssistantLine && !lastAssistantLine.endsWith('?') ? lastAssistantLine : null) ?? lastArtifact?.name ?? null
  const sumBits = [sections && sections.length > 0 ? CHAT.activitySections(sections.length) : null, lastArtifact ? CHAT.activityFile(lastArtifact.name) : null].filter(Boolean)

  return (
    <div>
      {/* 정상 상태에서는 대화만 보인다 — 설치됨/연결됨/버전 뱃지와 벤더 세그먼트는 없다(03-화면/02 기각). */}
      <Toolbar title={CHAT.title} sub={status !== null || statusFailed ? undefined : <Badge label={CHAT.checking} />} />
      {/* deps 준비 실패·정본 읽기 실패 등 프로젝트 수준 오류도 여기서 표면화된다. */}
      {pError && <Feedback kind={pError.kind} title={pError.title} body={pError.action} details={<code>{pError.raw}</code>} actions={<button onClick={clearPError}>닫기</button>} />}
      {statePieces.length > 0 && (
        <div className="state-line">
          {statePieces.map((p, i) => (
            <Fragment key={p}>{i > 0 && <span className="sep">·</span>}<button className="lk" onClick={() => setScreen('checkup')}>{p}</button></Fragment>
          ))}
        </div>
      )}
      {chatErr && <Feedback kind={chatErr.kind} title={chatErr.title} body={chatErr.action} details={<code>{chatErr.raw}</code>} actions={<button onClick={clearError}>닫기</button>} />}
      {snapshot?.state === 'stopped' && (
        <Feedback kind="warning" title={CHAT.stoppedTitle} body={CHAT.stoppedBody}
          actions={lastUncertain ? <button onClick={() => void send(lastUncertain.text)} disabled={running || busy}>{CHAT.resend}</button> : undefined} />
      )}
      {snapshot?.state === 'interrupted' && (
        <Feedback kind="warning" title={CHAT.interruptedTitle} body={CHAT.interruptedBody}
          actions={lastUncertain ? <button onClick={() => void send(lastUncertain.text)} disabled={running || busy}>{CHAT.resend}</button> : undefined} />
      )}
      {snapErr && <Feedback kind="error" title={snapErr.title} body={snapErr.action} details={<code>{snapErr.raw}</code>} />}

      {/* 빈 대화: "시작하기"를 타이핑하게 하지 않고 버튼이 문자열을 대신 보낸다(03-화면/03 결정). */}
      {emptyChat && (
        <div className="empty" style={{ padding: 'var(--sp-8)' }}>
          <div className="t" style={{ fontSize: 'var(--fs-heading)' }}>{CHAT.emptyTitle}</div>
          {status?.connected && !statusFailed ? (<>
            <div>{CHAT.emptyBodyStart}{claudeFound ? ` ${CHAT.pickHelperTitle}` : ''}</div>
            {claudeFound ? (<>
              <div className="row" style={{ marginTop: 'var(--sp-3)', alignItems: 'stretch' }}>
                <button className="opt-card" onClick={() => startCodex('시작하기')}>
                  <span className="t">{CHAT.pickCodexTitle}</span><span className="b">{CHAT.pickCodexBody}</span>
                </button>
                <button className="opt-card" onClick={() => startClaude('시작하기')}>
                  <span className="t">{CHAT.pickClaudeTitle}</span><span className="b">{CHAT.pickClaudeBody}</span>
                </button>
              </div>
              <div className="caption" style={{ marginTop: 'var(--sp-3)' }}>{CHAT.pickHelperBody}{hasRevision && <> — <button className="lk" onClick={() => startCodex('이어서 하기')}>{CHAT.resume}</button></>}</div>
            </>) : (
              <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
                <button className="primary" onClick={() => startCodex('시작하기')}>{CHAT.startNew}</button>
                {hasRevision && <button onClick={() => startCodex('이어서 하기')}>{CHAT.resume}</button>}
              </div>
            )}
          </>) : <div>{CHAT.emptyBody}</div>}
        </div>
      )}
      <div className="chat-log">
        {snapshot?.messages.map((m) => (
          <Message key={m.id} m={m} onGoArtifacts={() => setScreen('artifacts')} onResend={!running && m.delivery === 'uncertain' ? () => void send(m.text) : undefined} />
        ))}
      </div>

      {snapshot?.permission && (
        <div className="card">
          <div className="card-head"><h2>{snapshot.permission.title}</h2></div>
          <div className="prose">{snapshot.permission.detail}</div>
          <div className="caption" style={{ marginTop: 'var(--sp-2)' }}>{CHAT.allowAlwaysHint}</div>
          <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
            <button className="primary" onClick={() => void respond(snapshot.permission!.id, true)}>{CHAT.allow}</button>
            {/* 판정할 수 없는 명령(heredoc 으로 밀어 넣는 프로그램 등)을 반복해서 묻는 대신
                폴더 단위로 한 번 정하게 한다. 읽을 수 없는 것을 계속 클릭하게 만들면
                그건 보호가 아니라 습관적 승인을 기르는 일이다. */}
            <button onClick={() => { if (projectRoot) void window.knuaf.trustProject(projectRoot, true); void respond(snapshot.permission!.id, true) }}>{CHAT.allowAlways}</button>
            <button onClick={() => void respond(snapshot.permission!.id, false)}>{CHAT.deny}</button>
          </div>
        </div>
      )}

      {running && (
        <div className="progress">
          <div className="progress-head">
            <span className="spin" />
            <span className="caption">{CHAT.runningBody}</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => void stop()}>{CHAT.stop}</button>
          </div>
        </div>
      )}

      {/* "방금 한 일" — 대화 로그와 입력창 사이. 도우미 미연결에서도 같은 모양(프로젝트 데이터라서). */}
      {actTitle && (
        <div className="activity">
          <div className="status">{running && <span className="pulse" />}{running ? `${CHAT.activityBusy} · ` : ''}{lastAt ? relativeTime(lastAt) : ''}</div>
          <div className="title">{actTitle.length > 90 ? `${actTitle.slice(0, 90)}…` : actTitle}</div>
          <div className="sum">
            {sumBits.length > 0 && <span>{sumBits.join(' · ')}</span>}
            {failCount > 0 && <span><button className="lk" onClick={() => setScreen('checkup')}>{CHAT.activityFix(failCount)}</button></span>}
          </div>
        </div>
      )}

      {status === null && !statusFailed ? (
        <p className="caption">{CHAT.checking}</p>
      ) : statusFailed || !status!.connected ? (
        // 미연결 또는 상태 확인 실패: 입력창 자리에 CTA + draft가 있으면 복사 카드. 입력칸이
        // 사라져도 "답변에 첨부"/"고쳐달라기"가 쓴 draft가 조용히 삼켜지지 않아야 한다.
        <>
          <div className="empty">
            <div className="t">{statusFailed ? CHAT.statusFailTitle : status?.installed ? CHAT.needLoginTitleFor(provider) : CHAT.needInstallTitle}</div>
            <div>{statusFailed ? CHAT.statusFailBody : status?.installed ? CHAT.needLoginBody : CHAT.needInstallBody}</div>
            {!statusFailed && status?.detail && <div className="caption">{status.detail}</div>}
            <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
              {statusFailed
                ? <button className="primary" onClick={() => void refreshStatus()} disabled={busy}>{CHAT.recheck}</button>
                : status?.installed
                  ? <button className="primary" onClick={() => void login()} disabled={busy}>{CHAT.loginFor(provider)}</button>
                  : <button className="primary" onClick={() => void window.knuaf.openGuide()}>{CHAT.installGuide}</button>}
              {claudeFound && provider !== 'claude' && <button onClick={() => startClaude('시작하기')}>{CHAT.claudeStart}</button>}
              {!statusFailed && <button className="quiet" onClick={() => void refreshStatus()} disabled={busy}>{CHAT.recheck}</button>}
            </div>
          </div>
          {draft.trim() ? (
            <div className="card">
              <div className="card-head"><h2>{CHAT.draftCopyTitle}</h2></div>
              <div className="prose">{draft}</div>
              <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
                <button onClick={copyDraft}>{copied ? CHAT.draftCopied : CHAT.draftCopy}</button>
                <span className="caption">{CHAT.draftCopyHintWait}</span>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="chat-composer" data-dragging={dragging || undefined}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault(); e.stopPropagation(); setDragging(false)
            const f = e.dataTransfer.files[0]
            if (f) insertPath(window.knuaf.pathForFile(f))
          }}>
          <textarea value={draft} rows={3} placeholder={CHAT.placeholder} title={CHAT.placeholderHint} disabled={running}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
          <div className="row between">
            <div className="row">
              <button onClick={() => void attach()}>{CHAT.attach}</button>
              <span className="caption">{CHAT.attachHint}</span>
            </div>
            <button className="primary" onClick={() => void send()} disabled={running || busy || !draft.trim()}>{CHAT.send}</button>
          </div>
        </div>
      )}
      <div ref={endRef} aria-hidden="true" />
      {!atBottom && snapshot && snapshot.messages.length > 0 && (
        <button className="to-bottom" onClick={() => toBottom(true)}>{CHAT.toBottom}</button>
      )}
    </div>
  )
}
