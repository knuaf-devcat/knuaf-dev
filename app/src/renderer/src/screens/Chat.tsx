import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useProject } from '../store/project'
import { chatProvider, resolveChatMode, useChat, type ChatMode } from '../store/chat'
import { chosenProvider, useConnect } from '../store/connect'
import { useReview, buildQuotedMessage } from '../store/review'
import { FirstRun } from '../components/FirstRun'
import { ReviewQuoteChip } from '../components/ReviewQuote'
import { PopHead, Popover, PopSep } from '../components/Popover'
import { AccountChooser, useAccountProvider } from '../components/AccountChooser'
import { Disclosure } from '../components/Disclosure'
import { QuestionCard } from '../components/QuestionCard'
import { Feedback } from '../components/Feedback'
import { Icon } from '../components/Icon'
import { Badge } from '../components/Badge'
import { CHAT, CHAT_EVENT, CLOSE_LABEL, PROVIDER_NAME, describeChatError } from '../copy'
import { zoneOf } from '../../../shared/zone'
import type { ChatMessage, Provider } from '../../../shared/chat'
import { useShallow } from 'zustand/react/shallow'

/** [이름](경로) 한 쌍. 줄바꿈을 넘지 않는다 — 산문 한가운데의 링크만 집는다. */
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g
/** 프로젝트 안 상대경로처럼 생긴 것만. 주소(http:)·절대경로·.. 는 제외한다. */
const INSIDE_PATH = /^(?![/\\]|[a-zA-Z][a-zA-Z0-9+.-]*:)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$)).+$/

/**
 * 도우미 답변의 파일 링크를 누를 수 있게 만든다 — 마크다운 원문이 그대로 보이고
 * 접근성 역할도 일반 텍스트였다(GUI 감사 GUI-12).
 *
 * 경로는 "파일 얘기구나"를 판단하는 데만 쓰고 **절대 열지 않는다**. 누르면 결과물
 * 시트로 갈 뿐이고, 파일에 닿는 일은 앱이 스스로 목록에서 확인한 경로로만 한다.
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
  // 도우미는 **테두리·상자·발화자/시간 머리 없는 본문**, 학생만 오른쪽 말풍선(시안 D/E/G, N-I01).
  return (
    <div className={`chat-msg ${m.role}`}>
      <div className="prose">{m.role === 'assistant' && onGoArtifacts ? withLinks(shown, onGoArtifacts) : shown}</div>
      {folding && fold && (
        <div className="q-fold">
          <span className="caption">{CHAT.foldHint(fold.count)}</span>
          <span className="caption">·</span>
          <button className="lk" onClick={() => setUnfolded(true)}>{CHAT.unfold}</button>
        </div>
      )}
      {long && <button className="lk" onClick={() => setOpen(!open)}>{open ? CHAT.showLess : CHAT.showMore(m.text.length - LONG_MESSAGE)}</button>}
      {m.role === 'user' && (m.delivery === 'pending' || m.delivery === 'uncertain') && (
        <div className="chat-delivery">
          {m.delivery === 'pending' && <Badge tone="warning" label={CHAT.sending} />}
          {m.delivery === 'uncertain' && <Badge tone="fail" label={CHAT.uncertain} />}
        </div>
      )}
      {m.role === 'user' && m.delivery === 'uncertain' && onResend && <button onClick={onResend}>{CHAT.resend}</button>}
    </div>
  )
}

/**
 * 대화 이벤트 줄 — 도우미가 절을 저장한 사실을 앱이 그린다(IMPL-PLAN §3 신규).
 * 절 제목은 `project.sections`에서 온다(도우미 답변의 머리 배너를 되뇌지 않는다).
 * 대화 기록 파일에는 없다 — 앱을 다시 켜면 이 줄도 사라진다.
 */
function EventLine({ title, onGo }: { title: string; onGo: () => void }) {
  return (
    <div className="chat-event">
      <Icon name="doc" size={14} />
      <span>{CHAT_EVENT.wrote(title)}</span>
      <button className="lk" onClick={onGo}>{CHAT_EVENT.goPaper}</button>
    </div>
  )
}

/**
 * 폴더 없음 — 재실행 첫 화면이다(발주 QA 재실행 결정). 첫 실행과 **같은 두 단계 부품**
 * (`FirstRun`)을 제목줄이 있는 대화 칸 안에 얹는다. 연결이 확인돼 있으면 길잡이가
 * "AI 연결 ✓ → 논문 폴더 → 시작"으로 서고 폴더 단계부터, 끊겨 있으면 1단계(AI 연결)부터다.
 * 최근 논문을 자동으로 열지 않는다 — 학생이 고른다. 폴더를 고른 순간의 시작 의사는 남기지
 * 않는다(첫 실행과 달리, 여기서는 이미 지난 학생의 이어 쓰기를 앱이 대신 시작하지 않는다).
 */
function NoFolder() {
  return (
    <div className="onb">
      <div className="onb-inner"><FirstRun /></div>
    </div>
  )
}

/**
 * 입력칸 `+` 오른쪽의 칩 — 지금 연결된 AI 이름 + `생각 깊이 기본`(발주 I-02 ①, **표시만**).
 * 누르면 작은 팝오버가 열린다: 위는 AI 바꾸기(제목줄 계정 팝오버와 같은 `AccountChooser`),
 * 아래는 생각 깊이 한 줄을 **흐린 비활성**으로 — 값은 지어내지 않고 "곧 고를 수 있어요"만 말한다.
 * 실제 모델·추론 값을 넘기는 코드는 건드리지 않는다(안 주면 CLI 기본값이 쓰이는 지금 동작 그대로).
 */
function ComposerModelChip() {
  const [open, setOpen] = useState(false)
  const { provider } = useAccountProvider()
  return (
    <div className="pop-host">
      <button type="button" className="model" title={CHAT.modelChipTitle} aria-expanded={open} onClick={() => setOpen(!open)}>
        {PROVIDER_NAME[provider]} · {CHAT.depthChip}<Icon name="chevronDown" size={12} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="left" placement="up" width={400} label={CHAT.modelChipTitle}>
        <AccountChooser onPicked={() => setOpen(false)} />
        <PopSep />
        <PopHead>{CHAT.depthTitle}</PopHead>
        <div className="pop-row off" aria-disabled="true">
          <span className="c"><b>{CHAT.depthDefault}</b><small>{CHAT.depthFollows(PROVIDER_NAME[provider])}</small></span>
          <span className="m">{CHAT.depthSoon}</span>
        </div>
      </Popover>
    </div>
  )
}

/** "내 논문": 도우미와의 대화 — 인터뷰와 작문이 일어나는 곳. 폴더가 없으면 폴더 고르기 상태가 된다. */
export function Chat() {
  const projectRoot = useProject((s) => s.root)
  const settings = useProject((s) => s.settings)
  const pStatus = useProject((s) => s.status)
  const pError = useProject((s) => s.error)
  const clearPError = useProject((s) => s.clearError)
  const openSheet = useProject((s) => s.openSheet)
  const events = useProject((s) => s.events)
  const focusSection = useProject((s) => s.focusSection)
  const paperClosed = useProject((s) => s.paperClosed)
  const setPaperClosed = useProject((s) => s.setPaperClosed)
  const setPaneView = useProject((s) => s.setPaneView)
  const revision = useProject((s) => s.status?.revision ?? s.peek?.revision ?? null)
  const { root, snapshot, status, statusFailed, connState, draft, busy, error, mode, setDraft, insertPath, clearError, load, refreshStatus, login, send, respond, stop } = useChat(useShallow((s) => ({ root: s.root, snapshot: s.snapshot, status: s.status, statusFailed: s.statusFailed, connState: s.connState, draft: s.draft, busy: s.busy, error: s.error, mode: s.mode, setDraft: s.setDraft, insertPath: s.insertPath, clearError: s.clearError, load: s.load, refreshStatus: s.refreshStatus, login: s.login, send: s.send, respond: s.respond, stop: s.stop })))
  /** 온보딩 2단계에서 폴더를 고른 순간의 시작 의사 — 한 번만 쓴다(store/chat.ts 주석). */
  const startIntent = useChat((s) => s.startIntent)
  const disarmStart = useChat((s) => s.disarmStart)
  /**
   * 지금 대화할 공급자. 우선순위: 학생이 고른 것(온보딩 1단계·설정·계정) → 세션에서 고른 것
   * → 옛 설정(`helper_mode`). 연결 상태도 같은 공급자를 본다.
   */
  const connectSelected = useConnect((s) => s.selected)
  const seg: ChatMode = resolveChatMode(mode, settings)
  const provider: Provider = chosenProvider(connectSelected, settings) ?? chatProvider(seg)
  const endRef = useRef<HTMLDivElement>(null)
  /** 입력칸 — 한 줄에서 시작해 글이 늘면 자란다(시안 P/L). 최대 높이 뒤에는 스크롤. */
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [copied, setCopied] = useState(false)

  // 스냅샷의 provider가 화면 provider와 다르면(설정·시작 버튼으로 모드 전환) 다시 불러온다 —
  // codex 대화가 claude 화면에 남는 식의 혼합은 없어야 한다.
  useEffect(() => { if (projectRoot && (projectRoot !== root || provider !== snapshot?.provider)) void load(projectRoot, provider) }, [projectRoot, root, snapshot?.provider, provider, load])
  /**
   * 예전에는 `.chat-log` 를 스크롤하려 했는데 그 요소에는 overflow 가 없다 — 실제로
   * 흐르는 것은 화면 전체(.main)여서 이 호출은 아무 일도 하지 않았다(시험주행 발견 5).
   * v5에서는 대화 칸이 자기 안에서 흐르므로(`.chat-thread`) 이제 실제로 움직인다.
   *
   * 바닥에 붙어 있을 때만 따라 내려간다 — 위를 읽는 중인 학생의 화면을 빼앗지 않는다.
   * 허락 카드는 예외다. 진행을 막는 것이라 어디를 보고 있든 데려간다.
   */
  const toBottom = (smooth = false): void => endRef.current?.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' })
  useEffect(() => {
    const el = endRef.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setAtBottom(e.isIntersecting), { rootMargin: '0px 0px -8px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  useEffect(() => { toBottom() }, [root, snapshot?.provider])
  useEffect(() => { if (atBottom) toBottom() }, [snapshot?.messages.length, snapshot?.state, events.length])
  useEffect(() => { if (snapshot?.permission) toBottom() }, [snapshot?.permission?.id])

  const running = snapshot?.state === 'running' || snapshot?.state === 'permission'
  const lastUncertain = snapshot?.messages.filter((m) => m.role === 'user' && m.delivery === 'uncertain').at(-1)
  const attach = async (): Promise<void> => { const p = await window.knuaf.pickFile({ title: CHAT.attach }); if (p) insertPath(p) }

  /**
   * 종이에서 고른 문장(인용) — 입력칸 위 칩이 보여 주고, 보낼 때 메시지에 합쳐진다(N-I03).
   * 두 상태 다 앱 메모리에만 산다(정본 폴더에 쓰지 않는다).
   */
  const quote = useReview((s) => s.quote)
  const clearQuote = useReview((s) => s.clearQuote)
  /**
   * 보내기 — 인용이 붙어 있으면 `> 문장 · (장에서) · 글` 형식으로 합쳐 보낸다(발주 QA2-B §2 (a)).
   * **인용은 그 논문의 것**이라 다른 폴더 대화에는 붙이지 않는다(QA2B-R1-01). 초안은
   * `consumeDraft` 로 넘겨 일반 전송과 **같은 규칙**으로 소비한다 — 보낸 글이 입력칸에 남지 않고,
   * 전송 중 새로 쓴 글은 지켜진다(QA2B-R1-02). 보낸 뒤에는 그 인용이 아직 그대로일 때만 지운다
   * — 늦게 온 결과가 그사이 새로 붙인 인용을 지우지 않게.
   */
  const sendBody = async (text?: string): Promise<boolean> => {
    const q = useReview.getState().quote
    if (!q || q.root !== projectRoot) return send(text)
    const ok = await send(buildQuotedMessage(q, text ?? draft), { consumeDraft: true })
    if (ok && useReview.getState().quote === q) clearQuote()
    return ok
  }

  // 인용은 그 논문의 것 — 다른 논문을 열면 지운다(QA2B-R1-01).
  useEffect(() => {
    const q = useReview.getState().quote
    if (q && q.root !== projectRoot) clearQuote()
  }, [projectRoot, clearQuote])

  // 고쳐 달라기를 누르면 인용이 붙는다 — 입력칸으로 초점을 옮겨 바로 쓰게 한다(QA2B-R1-06).
  useEffect(() => { if (quote) taRef.current?.focus() }, [quote])

  /** 인용만 있어도 보낼 수 있다 — "이 부분을 고쳐 줘"만 원하는 경우(발주 QA2-B §2 (a)). */
  const canSend = !!draft.trim() || !!quote

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

  const copyDraft = (): void => {
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
  /**
   * 입력칸 높이를 내용에 맞춘다 — `height:auto` 로 되돌린 뒤 `scrollHeight` 를 준다(그래야
   * 글이 줄어도 줄어든다). 최대 높이는 CSS(`max-height`)가 막고 그 위로는 스크롤이다.
   *
   * 의존성에 `zone.kind` 를 넣는 이유(검토 QA-R1-02): 허락·질문 카드가 입력칸 자리를
   * 차지하면 textarea 가 사라졌다가 다시 나타나는데, Chat 자신은 계속 마운트돼 있고 초안도
   * 그대로라 `[draft]` 만으로는 다시 실행되지 않았다 — 5줄 초안이 한 줄 높이로 줄어 보였다.
   * 구역이 입력칸으로 돌아올 때도 높이를 다시 잰다.
   */
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft, zone.kind])
  /**
   * 대화 이벤트 줄의 "종이에서 보기" — 학생이 **명시적으로** 누른 이동이다. 그래서 닫아 둔
   * 종이도 다시 열고(자동으로 열리지 않는 규칙은 저장·감시에만 적용된다), 좁은 창이면 종이로
   * 넘어간다. 둘 중 하나만 하면 화면이 안 바뀐다(검토 P3-R1-04).
   */
  const goPaper = (sectionId: string): void => {
    focusSection(sectionId)
    setPaneView('paper')
    if (paperClosed) setPaperClosed(false)
  }

  if (!projectRoot) return <NoFolder />

  /**
   * 대화 기록과 이벤트 줄을 **시각 순으로** 섞는다 — 이벤트 줄은 저장된 글이 아니라 앱이
   * 그리는 표시라 대화 파일에 없고, 그래서 화면에서만 순서를 맞춘다.
   */
  const thread: { key: string; at: number; node: ReactNode }[] = []
  for (const m of snapshot?.messages ?? []) {
    thread.push({
      key: m.id, at: Date.parse(m.at) || 0,
      node: <Message key={m.id} m={m} onGoArtifacts={() => openSheet('artifacts')} onResend={!running && m.delivery === 'uncertain' ? () => void send(m.text) : undefined}
        fold={zone.kind === 'question' && zone.messageId === m.id ? { span: zone.card.span, count: zone.card.options.length } : undefined} />
    })
  }
  for (const e of events) thread.push({ key: `ev-${e.id}`, at: Date.parse(e.at) || 0, node: <EventLine key={`ev-${e.id}`} title={e.title} onGo={() => goPaper(e.sectionId)} /> })
  thread.sort((a, b) => a.at - b.at)

  return (
    <div className="chat-inner">
      {pError && <Feedback kind={pError.kind} title={pError.title} body={pError.action} details={<code>{pError.raw}</code>} actions={<button onClick={clearPError}>{CLOSE_LABEL}</button>} />}
      {chatErr && <Feedback kind={chatErr.kind} title={chatErr.title} body={chatErr.action} details={<code>{chatErr.raw}</code>} actions={<button onClick={clearError}>{CLOSE_LABEL}</button>} />}
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
        <div className="chat-empty">
          <div className="t">{CHAT.emptyTitle}</div>
          {status?.connected && !statusFailed ? (<>
            <div>{CHAT.emptyBodyStart}</div>
            {/* 고른 AI 로 바로 시작한다 — AI 를 고르는 자리는 첫 실행 1단계와 계정 팝오버다
                (여기서 다시 고르게 하지 않는다, DESIGN §4). 고르는 규칙은 그대로다. */}
            <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
              <button className="primary" onClick={() => void send(hasRevision ? CHAT.firstTurnNext : CHAT.firstTurn)}>{hasRevision ? CHAT.resume : CHAT.startNew}</button>
            </div>
            <p className="caption">{CHAT.emptyChangeAi}</p>
          </>) : <div>{CHAT.emptyBody}</div>}
        </div>
      )}

      <div className="chat-thread">
        {thread.map((t) => <Fragment key={t.key}>{t.node}</Fragment>)}
        <div ref={endRef} aria-hidden="true" />
      </div>
      {!atBottom && snapshot && snapshot.messages.length > 0 && (
        <button className="to-bottom" onClick={() => toBottom(true)}>{CHAT.toBottom}</button>
      )}

      {/* 아래 칸 — 질문 카드 · 허락 카드 · 작업 중 한 줄 · 입력칸이 이 한 자리를 번갈아 쓴다.
          무엇이 쓸지는 zone.ts 한 함수가 정한다(설계 §4-1). */}
      <div className="chat-zone">
        {zone.kind === 'permission' && (
          <div className="askcard" role="alert">
            <div className="askcard-h"><span className="ask-dot" />{CHAT.askTitle}</div>
            <div className="askcard-t">{zone.request.title}</div>
            {/* 합쳐진 detail 을 첫 줄=명령으로 나누지 않는다 — 여러 줄 명령(command 두 줄)이거나
                이유만 있는 요청을 오분류했다(QA2A-R1-02). 원문을 줄바꿈 그대로 한 덩어리로 보여 준다. */}
            {zone.request.detail && <div className="askcard-raw">{zone.request.detail}</div>}
            <div className="caption">{CHAT.allowAlwaysHint}</div>
            <Disclosure label={CHAT.askDetail}>
              <div className="prose">{zone.request.detail}</div>
            </Disclosure>
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
            {/* 인용 칩 — 입력칸 바로 위(N-I03). 이 논문의 인용만 보여 준다(QA2B-R1-01). */}
            {quote && quote.root === projectRoot && <ReviewQuoteChip quote={quote} onRemove={clearQuote} />}
            <div className="chat-composer" data-dragging={dragging || undefined}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault(); e.stopPropagation(); setDragging(false)
                const f = e.dataTransfer.files[0]
                if (f) insertPath(window.knuaf.pathForFile(f))
              }}>
              {/* 한 줄에서 시작해 글이 늘면 자란다 — 최대 높이 뒤에는 스크롤(시안 P/L). */}
              <textarea ref={taRef} value={draft} rows={1} placeholder={CHAT.placeholder} title={CHAT.placeholderHint}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  // 보내기 단추와 같은 조건이다. 작업 중·전송 중에는 키보드로도 보내지 않는다 —
                  // 단추만 막으면 Enter 로 들어와 main 의 소유권 잠금에 걸린다(검토 P1-R1-03).
                  if (zone.kind === 'running' || busy || !canSend) return
                  void sendBody()
                }} />
              <div className="crow">
                {/* 왼쪽 아래 32×32 원형 `+` — 파일 첨부(기존 동작 그대로). */}
                <button type="button" className="circ" title={CHAT.attach} aria-label={CHAT.attach} onClick={() => void attach()}><Icon name="plus" size={16} /></button>
                <ComposerModelChip />
                <span className="sp" />
                {/* 오른쪽 아래 34×34 원형 위 화살표(먹색 채움) — 작업 중이면 같은 자리 멈추기. */}
                {zone.kind === 'running'
                  ? <button type="button" className="send" title={CHAT.stop} aria-label={CHAT.stop} onClick={() => void stop()}><Icon name="stop" size={13} /></button>
                  : <button type="button" className="send" title={CHAT.send} aria-label={CHAT.send} onClick={() => void sendBody()} disabled={busy || !canSend}><Icon name="up" size={17} /></button>}
              </div>
            </div>
            <p className="disc">{CHAT.disclaimer}</p>
          </>
        )}

        {zone.kind === 'disconnected' && (connState === 'checking' && status === null ? (
          <p className="caption">{CHAT.checking}</p>
        ) : (
          // 미연결·확인 실패·도구 없음: 입력창 자리에 CTA + draft가 있으면 복사 카드. 입력칸이
          // 사라져도 "답변에 첨부"/"고쳐달라기"가 쓴 draft가 조용히 삼켜지지 않아야 한다.
          <>
            <div className="zone-note">
              <div className="t">{chatConnTitle}</div>
              <div>{chatConnBody}</div>
              {connState !== 'no-tool' && status?.detail && <div className="caption">{status.detail}</div>}
              <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
                {connState === 'no-tool'
                  ? <button className="primary" onClick={() => void window.knuaf.openGuide()}>{CHAT.installGuide}</button>
                  : connState === 'need-login'
                    ? <button className="primary" onClick={() => void login()} disabled={busy}>{CHAT.loginFor(provider)}</button>
                    : <button className="primary" onClick={() => void refreshStatus()} disabled={busy}>{CHAT.recheck}</button>}
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
      </div>
    </div>
  )
}
