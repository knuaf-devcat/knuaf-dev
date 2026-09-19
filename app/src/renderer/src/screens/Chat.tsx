import { useEffect, useRef, useState } from 'react'
import { useProject } from '../store/project'
import { useChat, type ChatMode } from '../store/chat'
import { Toolbar } from '../components/Toolbar'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { Feedback } from '../components/Feedback'
import { Icon } from '../components/Icon'
import { SegmentedControl } from '../components/SegmentedControl'
import { AgentTerminal } from '../components/Terminal'
import { CHAT, SCREEN_INTRO, relativeTime } from '../copy'
import type { ChatMessage } from '../../../shared/chat'

function Message({ m, onResend }: { m: ChatMessage; onResend?: () => void }) {
  if (m.role === 'system') return <div className="chat-msg system"><span className="caption">{m.text}</span></div>
  return (
    <div className={`chat-msg ${m.role}`}>
      <div className="chat-msg-head">
        <span className="chat-who">{m.role === 'user' ? CHAT.me : CHAT.assistant}</span>
        <span className="caption">{relativeTime(m.at)}</span>
        {m.role === 'user' && m.delivery === 'pending' && <Badge tone="warning" label={CHAT.sending} />}
        {m.role === 'user' && m.delivery === 'uncertain' && <Badge tone="fail" label={CHAT.uncertain} />}
      </div>
      <div className="prose">{m.text}</div>
      {m.delivery === 'uncertain' && onResend && <button onClick={onResend}>{CHAT.resend}</button>}
    </div>
  )
}

/** "내 논문": Codex chat and the embedded Claude/Codex terminals — interview and drafting happen here. */
export function Chat() {
  const projectRoot = useProject((s) => s.root)
  const settings = useProject((s) => s.settings)
  const revision = useProject((s) => s.status?.revision ?? s.peek?.revision ?? null)
  const { root, snapshot, status, draft, busy, error, mode, setMode, setDraft, insertPath, clearError, load, refreshStatus, login, send, respond, stop } = useChat()
  const logRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => { if (projectRoot && projectRoot !== root) void load(projectRoot) }, [projectRoot, root, load])
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [snapshot?.messages.length, snapshot?.state])

  const running = snapshot?.state === 'running' || snapshot?.state === 'permission'
  const lastUncertain = snapshot?.messages.filter((m) => m.role === 'user' && m.delivery === 'uncertain').at(-1)
  const attach = async () => { const p = await window.knuaf.pickFile({ title: CHAT.attach }); if (p) insertPath(p) }

  // Two tabs, three modes: the Codex tab is chat unless Settings prefers the terminal.
  const codexMode: ChatMode = settings?.codex_terminal ? 'codex-term' : 'codex-chat'
  const seg: ChatMode = mode === 'claude-term' ? 'claude-term' : codexMode
  const isTerm = seg !== 'codex-chat'

  return (
    <div className={isTerm ? 'chat-term-mode' : undefined}>
      <Toolbar title={CHAT.title} sub={isTerm ? undefined : <>
        {status === null ? <Badge label={CHAT.checking} /> : <>
          <Badge tone={status.installed ? 'pass' : 'fail'} label={status.installed ? CHAT.installed : CHAT.notInstalled} />
          <Badge tone={status.connected ? 'pass' : undefined} label={status.connected ? CHAT.connected : CHAT.disconnected} />
          {status.version && <Badge label={status.version} />}
        </>}
        {snapshot?.skillLoaded && <Badge tone="accent" label={CHAT.skillLoaded} />}
      </>} actions={isTerm ? undefined : <>
        {status && !status.installed && <button onClick={() => void window.knuaf.openGuide()}>{CHAT.installGuide}</button>}
        {status?.installed && !status.connected && <button className="primary" onClick={() => void login()} disabled={busy}>{CHAT.login}</button>}
        <button onClick={() => void refreshStatus()} disabled={busy}><Icon name="refresh" size={16} /> {CHAT.recheck}</button>
      </>} />
      <p className="intro">{SCREEN_INTRO.chat}</p>
      <div className="chat-seg">
        <SegmentedControl<ChatMode> value={seg} label={CHAT.title} onChange={setMode}
          options={[{ id: codexMode, label: CHAT.segCodex }, { id: 'claude-term', label: CHAT.segClaude }]} />
      </div>
      {isTerm ? (<>
        <p className="caption">{CHAT.termNotice}</p>
        {projectRoot && <AgentTerminal root={projectRoot} kind={seg === 'codex-term' ? 'codex' : 'claude'} revision={revision} />}
      </>) : (<>
      {status?.detail && <p className="caption">{status.detail}</p>}

      {error && <Feedback kind="warning" title={error} actions={<button onClick={clearError}>닫기</button>} />}
      {snapshot?.state === 'interrupted' && (
        <Feedback kind="warning" title={CHAT.interruptedTitle} body={CHAT.interruptedBody}
          actions={lastUncertain ? <button onClick={() => void send(lastUncertain.text)} disabled={running || busy}>{CHAT.resend}</button> : undefined} />
      )}
      {snapshot?.error && snapshot.state !== 'interrupted' && <Feedback kind="error" title={snapshot.error} />}

      {snapshot && snapshot.messages.length === 0 && <EmptyState icon="doc" title={CHAT.emptyTitle} body={CHAT.emptyBody} />}
      <div className="chat-log" ref={logRef}>
        {snapshot?.messages.map((m) => (
          <Message key={m.id} m={m} onResend={!running && m.delivery === 'uncertain' ? () => void send(m.text) : undefined} />
        ))}
      </div>

      {snapshot?.permission && (
        <div className="card">
          <div className="card-head"><h2>{snapshot.permission.title}</h2></div>
          <div className="prose">{snapshot.permission.detail}</div>
          <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
            <button className="primary" onClick={() => void respond(snapshot.permission!.id, true)}>{CHAT.allow}</button>
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

      <div className="chat-composer" data-dragging={dragging || undefined}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault(); e.stopPropagation(); setDragging(false)
          const f = e.dataTransfer.files[0]
          if (f) insertPath(window.knuaf.pathForFile(f))
        }}>
        <textarea value={draft} rows={3} placeholder={CHAT.placeholder} disabled={running}
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
      </>)}
    </div>
  )
}
