import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useProject } from '../store/project'
import { chatProvider, resolveChatMode, useChat, type ChatMode } from '../store/chat'
import { chosenProvider, useConnect } from '../store/connect'
import { rpc } from '../rpc'
import { Toolbar } from '../components/Toolbar'
import { Badge } from '../components/Badge'
import { Feedback } from '../components/Feedback'
import { FolderPicker } from '../components/FolderPicker'
import { QuestionCard } from '../components/QuestionCard'
import { CHAT, FOLDER, describeChatError, relativeTime } from '../copy'
import { waitingQuestionCount, zoneOf } from '../../../shared/zone'
import type { ChatMessage, Provider } from '../../../shared/chat'
import type { ArtifactItem, SectionRow } from '../../../shared/types'
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

/**
 * 카드가 떠 있는 동안 대화 원문에서 접을 보기 줄 범위. 같은 보기가 카드와 원문에 두 번
 * 보이면 어디를 눌러야 할지 헷갈린다 — 글자를 버리지는 않는다("여기에 펼치기").
 */
export interface FoldOptions { span: { start: number; end: number }; count: number }

function Message({ m, onResend, onGoArtifacts, fold }: { m: ChatMessage; onResend?: () => void; onGoArtifacts?: () => void; fold?: FoldOptions }) {
  const [open, setOpen] = useState(false)
  const [unfolded, setUnfolded] = useState(false)
  if (m.role === 'system') return <div className="chat-msg system"><span className="caption">{m.text}</span></div>
  const folding = !!fold && !unfolded
  const lines = m.text.split('\n')
  const text = folding && fold ? [...lines.slice(0, fold.span.start), ...lines.slice(fold.span.end + 1)].join('\n') : m.text
  const long = text.length > LONG_MESSAGE
  const shown = long && !open ? text.slice(0, LONG_MESSAGE) : text
  return (
    <div className={`chat-msg ${m.role}`}>
      <div className="chat-msg-head">
        <span className="chat-who">{m.role === 'user' ? CHAT.me : CHAT.assistant}</span>
        <span className="caption">{relativeTime(m.at)}</span>
        {m.role === 'user' && m.delivery === 'pending' && <Badge tone="warning" label={CHAT.sending} />}
        {m.role === 'user' && m.delivery === 'uncertain' && <Badge tone="fail" label={CHAT.uncertain} />}
      </div>
      <div className="prose">{m.role === 'assistant' && onGoArtifacts ? withLinks(shown, onGoArtifacts) : shown}</div>
      {folding && fold && (
        <div className="q-fold">
          <span className="caption">{CHAT.foldHint(fold.count)}</span>
          <span className="caption">·</span>
          <button className="lk" onClick={() => setUnfolded(true)}>{CHAT.unfold}</button>
        </div>
      )}
      {long && <button className="lk" onClick={() => setOpen(!open)}>{open ? CHAT.showLess : CHAT.showMore(m.text.length - LONG_MESSAGE)}</button>}
      {m.delivery === 'uncertain' && onResend && <button onClick={onResend}>{CHAT.resend}</button>}
    </div>
  )
}

/**
 * 폴더 없음 — "홈"이 아니라 내 논문의 한 상태(03-화면/01). 첫 실행은 온보딩 2단계가
 * **같은 부품**(`FolderPicker`)으로 폴더를 고르고, 여기는 재방문의 자리다(App.tsx 의 분기).
 * 경로 입력칸은 없고(설정 > 고급에만), 준비는 여는 순간 백그라운드로 돌아 실패만 표면화된다.
 */
function NoFolder() {
  return (
    <div>
      <Toolbar title={CHAT.title} />
      <FolderPicker copy={{ title: CHAT.noFolderTitle, intro: CHAT.noFolderIntro, ...FOLDER, recents: CHAT.recentTitle, foot: CHAT.noFolderBody }} />
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
  const { root, snapshot, status, statusFailed, connState, draft, busy, error, mode, setMode, setDraft, insertPath, clearError, load, refreshStatus, login, send, respond, stop } = useChat(useShallow((s) => ({ root: s.root, snapshot: s.snapshot, status: s.status, statusFailed: s.statusFailed, connState: s.connState, draft: s.draft, busy: s.busy, error: s.error, mode: s.mode, setMode: s.setMode, setDraft: s.setDraft, insertPath: s.insertPath, clearError: s.clearError, load: s.load, refreshStatus: s.refreshStatus, login: s.login, send: s.send, respond: s.respond, stop: s.stop })))
  /** 온보딩 2단계에서 폴더를 고른 순간의 시작 의사 — 한 번만 쓴다(store/chat.ts 주석). */
  const startIntent = useChat((s) => s.startIntent)
  const disarmStart = useChat((s) => s.disarmStart)
  /**
   * 지금 대화할 공급자. 우선순위: 학생이 고른 것(온보딩 1단계·설정·계정 변경) → 세션에서
   * 고른 것 → 옛 설정(`helper_mode`). 연결 상태도 같은 공급자를 본다.
   */
  const connectSelected = useConnect((s) => s.selected)
  const seg: ChatMode = resolveChatMode(mode, settings)
  const provider: Provider = chosenProvider(connectSelected, settings) ?? chatProvider(seg)
  const endRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [claudeFound, setClaudeFound] = useState(false)
  const [sections, setSections] = useState<SectionRow[] | null>(null)
  const [lastArtifact, setLastArtifact] = useState<ArtifactItem | null>(null)
  const [copied, setCopied] = useState(false)

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

  /**
   * 첫 대화 한 번 — 온보딩에서 폴더를 고른 순간이 학생의 시작 의사다(설계 §4-3 "첫 대화 시작").
   * 그 폴더의 대화가 비어 있고 연결돼 있으면 `시작하기`(기록이 있으면 `이어서 하기`)를 한 번
   * 보낸다. 의사는 보내는 순간 소비되므로 다시 보내지 않고, **다시 열었을 때**는 아무 일도
   * 일어나지 않는다 — 그때는 빈 대화의 단추를 학생이 직접 누른다.
   */
  useEffect(() => {
    if (!startIntent || !projectRoot || startIntent !== projectRoot) return
    if (!snapshot || snapshot.provider !== provider || status?.connected !== true) return
    disarmStart()
    if (snapshot.messages.length === 0) void send(hasRevision ? CHAT.firstTurnNext : CHAT.firstTurn)
  }, [startIntent, projectRoot, snapshot, status, provider, hasRevision, send, disarmStart])

  /**
   * 도우미를 고르는 순간은 **선택의 기록**이다 — 온보딩 1단계·설정 라디오와 같은 자격으로
   * `provider_choice` 를 남긴다(`helper_mode` 는 기본값이라 그것만으로는 "골랐음"이 안 된다).
   */
  const remember = (m: ChatMode) => {
    setMode(m)
    const p = chatProvider(m)
    useConnect.getState().select(p)
    void window.knuaf.setSettings({ helper_mode: m, provider_choice: { provider: p, at: new Date().toISOString() } }).then(() => loadSettings())
  }
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
  /**
   * 끊긴 자리에서 무엇을 말하고 무엇을 권할지 — 연결 상태 이름 하나로 정한다.
   * 확인 실패(failed·unknown)는 로그인 안내가 아니라 "확인하지 못했어요 + 다시 확인"이다.
   */
  const connFailed = connState === 'failed' || connState === 'unknown'
  const chatConnTitle = connFailed ? CHAT.statusFailTitle : connState === 'no-tool' ? CHAT.needInstallTitle : CHAT.needLoginTitleFor(provider)
  const chatConnBody = connFailed ? CHAT.statusFailBody : connState === 'no-tool' ? CHAT.needInstallBody : CHAT.needLoginBody

  // 아래 칸 하나를 정한다 — 허락 · 질문 카드 · 작업 중 · 입력칸 · 미연결(설계 §4-1).
  const zone = zoneOf(snapshot, status, pStatus ?? null)

  if (!projectRoot) return <NoFolder />

  // 지금 상태 한 줄 — 행동 단위 사실만. 말할 사실이 없으면 그리지 않는다(03-화면/03 결정).
  const failCount = pStatus?.checks.filter((c) => c.status === 'fail').length ?? 0
  // Checkup 과 같은 기준으로 마무리 항목을 빼야 "답변" 수가 진짜 질문 수가 된다 — 그 기준은
  // 카드 조건과 같은 함수(zone.ts)에 있다.
  const waitCount = waitingQuestionCount(pStatus ?? null)
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
  // 첫 줄이 늘 행동은 아니다 — 도우미 답변은 `> knuaf-dev · …` 머리글로 시작할 때가
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
                <button className="opt-card" onClick={() => startCodex(CHAT.firstTurn)}>
                  <span className="t">{CHAT.pickCodexTitle}</span><span className="b">{CHAT.pickCodexBody}</span>
                </button>
                <button className="opt-card" onClick={() => startClaude(CHAT.firstTurn)}>
                  <span className="t">{CHAT.pickClaudeTitle}</span><span className="b">{CHAT.pickClaudeBody}</span>
                </button>
              </div>
              <div className="caption" style={{ marginTop: 'var(--sp-3)' }}>{CHAT.pickHelperBody}{hasRevision && <> — <button className="lk" onClick={() => startCodex(CHAT.firstTurnNext)}>{CHAT.resume}</button></>}</div>
            </>) : (
              <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
                <button className="primary" onClick={() => startCodex(CHAT.firstTurn)}>{CHAT.startNew}</button>
                {hasRevision && <button onClick={() => startCodex(CHAT.firstTurnNext)}>{CHAT.resume}</button>}
              </div>
            )}
          </>) : <div>{CHAT.emptyBody}</div>}
        </div>
      )}
      <div className="chat-log">
        {snapshot?.messages.map((m) => (
          <Message key={m.id} m={m} onGoArtifacts={() => setScreen('artifacts')} onResend={!running && m.delivery === 'uncertain' ? () => void send(m.text) : undefined}
            fold={zone.kind === 'question' && zone.messageId === m.id ? { span: zone.card.span, count: zone.card.options.length } : undefined} />
        ))}
      </div>

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

      {/* 아래 칸 — 질문 카드 · 허락 카드 · 작업 중 한 줄 · 입력칸이 이 한 자리를 번갈아 쓴다.
          무엇이 쓸지는 zone.ts 한 함수가 정한다(설계 §4-1). */}
      {zone.kind === 'permission' && (
        <div className="askcard" role="alert">
          <div className="askcard-h"><span className="ask-dot" />{CHAT.askTitle}</div>
          <div className="askcard-t">{zone.request.title}</div>
          <div className="prose">{zone.request.detail}</div>
          <div className="caption">{CHAT.allowAlwaysHint}</div>
          <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
            <button className="primary" onClick={() => void respond(zone.request.id, true)}>{CHAT.allow}</button>
            {/* 판정할 수 없는 명령(heredoc 으로 밀어 넣는 프로그램 등)을 반복해서 묻는 대신
                폴더 단위로 한 번 정하게 한다. 읽을 수 없는 것을 계속 클릭하게 만들면
                그건 보호가 아니라 습관적 승인을 기르는 일이다. */}
            <button onClick={() => { if (projectRoot) void window.knuaf.trustProject(projectRoot, true); void respond(zone.request.id, true) }}>{CHAT.allowAlways}</button>
            <button onClick={() => void respond(zone.request.id, false)}>{CHAT.deny}</button>
          </div>
        </div>
      )}

      {zone.kind === 'question' && (
        <QuestionCard card={zone.card} draft={draft} onDraft={setDraft} onSend={send} />
      )}

      {(zone.kind === 'running' || zone.kind === 'composer') && (
        <>
          {/* 작업 중 한 줄 — 입력칸 위. 입력칸은 쓸 수 있게 두고 보내기만 막는다. */}
          {zone.kind === 'running' && (
            <div className="zone-status"><span className="spin" />{CHAT.runningLine}</div>
          )}
          <div className="chat-composer" data-dragging={dragging || undefined}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault(); e.stopPropagation(); setDragging(false)
              const f = e.dataTransfer.files[0]
              if (f) insertPath(window.knuaf.pathForFile(f))
            }}>
            <textarea value={draft} rows={3} placeholder={CHAT.placeholder} title={CHAT.placeholderHint}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                e.preventDefault()
                // 보내기 단추와 같은 조건이다. 작업 중·전송 중에는 키보드로도 보내지 않는다 —
                // 단추만 막으면 Enter 로 들어와 main 의 소유권 잠금에 걸린다(검토 P1-R1-03).
                if (zone.kind === 'running' || busy || !draft.trim()) return
                void send()
              }} />
            <div className="row between">
              <div className="row">
                <button onClick={() => void attach()}>{CHAT.attach}</button>
                <span className="caption">{CHAT.attachHint}</span>
              </div>
              {/* 보내기 자리가 작업 중에는 멈추기가 된다. */}
              {zone.kind === 'running'
                ? <button className="send" onClick={() => void stop()}>{CHAT.stop}</button>
                : <button className="send" onClick={() => void send()} disabled={busy || !draft.trim()}>{CHAT.send}</button>}
            </div>
          </div>
        </>
      )}

      {zone.kind === 'disconnected' && (connState === 'checking' && status === null ? (
        <p className="caption">{CHAT.checking}</p>
      ) : (
        // 미연결·확인 실패·도구 없음: 입력창 자리에 CTA + draft가 있으면 복사 카드. 입력칸이
        // 사라져도 "답변에 첨부"/"고쳐달라기"가 쓴 draft가 조용히 삼켜지지 않아야 한다.
        // 확인 실패(`probe:'failed'`)를 "로그인 필요"로 접지 않는다 — 도구는 있는데 대답을
        // 못 들은 것뿐이라, 로그인부터 요구하면 엉뚱한 재인증을 시킨다(P2-R1-01).
        <>
          <div className="empty">
            <div className="t">{chatConnTitle}</div>
            <div>{chatConnBody}</div>
            {connState !== 'no-tool' && status?.detail && <div className="caption">{status.detail}</div>}
            <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
              {connState === 'no-tool'
                ? <button className="primary" onClick={() => void window.knuaf.openGuide()}>{CHAT.installGuide}</button>
                : connState === 'need-login'
                  ? <button className="primary" onClick={() => void login()} disabled={busy}>{CHAT.loginFor(provider)}</button>
                  : <button className="primary" onClick={() => void refreshStatus()} disabled={busy}>{CHAT.recheck}</button>}
              {claudeFound && provider !== 'claude' && <button onClick={() => startClaude(CHAT.firstTurn)}>{CHAT.claudeStart}</button>}
              {/* 확인 실패에는 위의 주 단추가 이미 "다시 확인"이라 여기 또 두지 않는다. */}
              {connState !== 'failed' && connState !== 'unknown' && <button className="quiet" onClick={() => void refreshStatus()} disabled={busy}>{CHAT.recheck}</button>}
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
      ))}
      <div ref={endRef} aria-hidden="true" />
      {!atBottom && snapshot && snapshot.messages.length > 0 && (
        <button className="to-bottom" onClick={() => toBottom(true)}>{CHAT.toBottom}</button>
      )}
    </div>
  )
}
