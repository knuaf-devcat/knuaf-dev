import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Badge } from './Badge'
import { Confirm } from './Confirm'
import { Feedback } from './Feedback'
import { CHAT } from '../copy'
import type { TermInfo, TermKind } from '../../../shared/term'

/** xterm theme from the app's tokens; solid vars only (xterm cannot paint color-mix). */
function xtermTheme() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    background: v('--panel', dark ? '#2a2c2a' : '#ffffff'),
    foreground: v('--ink', dark ? '#ececea' : '#1c1f1b'),
    cursor: v('--ink', dark ? '#ececea' : '#1c1f1b'),
    selectionBackground: dark ? 'rgba(121,183,132,.35)' : 'rgba(47,107,58,.25)'
  }
}

/**
 * Embedded agent terminal. The pty lives in the main TerminalService keyed by root+kind, so the
 * session survives leaving this screen; remounting reconnects and replays the recent output ring.
 * The agent owns stdin — Korean IME goes through xterm untouched.
 */
export function AgentTerminal({ root, kind, revision }: { root: string; kind: TermKind; revision: number | null }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const idRef = useRef<string | null>(null)
  const [info, setInfo] = useState<TermInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmKill, setConfirmKill] = useState(false)

  const open = async (resume: boolean) => {
    const term = termRef.current
    if (!term) return
    const r = await window.knuaf.term.open(root, kind, { revision, resume, cols: term.cols, rows: term.rows })
    if (termRef.current !== term) return // unmounted while spawning
    if ('error' in r) { setError(r.error.message); return }
    setError(null)
    idRef.current = r.result.id
    setInfo(r.result)
    term.reset()
    const replay = await window.knuaf.term.replay(r.result.id)
    if (termRef.current !== term) return
    if ('result' in replay && replay.result) term.write(replay.result)
  }

  useEffect(() => {
    const term = new XTerm({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: xtermTheme()
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    fit.fit()

    const observer = new ResizeObserver(() => {
      fit.fit()
      if (idRef.current) void window.knuaf.term.resize(idRef.current, term.cols, term.rows)
    })
    observer.observe(hostRef.current!)

    const offData = window.knuaf.onTermData(({ id, data }) => { if (id === idRef.current) term.write(data) })
    const offExit = window.knuaf.onTermExit(({ id, exitCode }) => {
      if (id === idRef.current) setInfo((i) => (i ? { ...i, alive: false, exitCode } : i))
    })
    const input = term.onData((data) => { if (idRef.current) void window.knuaf.term.write(idRef.current, data) })
    const media = matchMedia('(prefers-color-scheme: dark)')
    const onScheme = () => { term.options.theme = xtermTheme() }
    media.addEventListener('change', onScheme)

    void open(false)

    return () => {
      observer.disconnect(); offData(); offExit(); input.dispose()
      media.removeEventListener('change', onScheme)
      termRef.current = null; idRef.current = null
      term.dispose()
    }
  }, [root, kind])

  const alive = !!info?.alive
  return (
    <div className="term-wrap">
      {error && <Feedback kind="error" title={error} />}
      <div className="term-host" ref={hostRef} />
      <div className="term-bar">
        <Badge tone={alive ? 'pass' : undefined} label={alive ? CHAT.termAlive : CHAT.termExited} />
        <span className="caption">{CHAT.termHint}</span>
        <span style={{ flex: 1 }} />
        {alive && <button onClick={() => setConfirmKill(true)}>{CHAT.termKill}</button>}
        {!alive && info && <>
          <button className="primary" onClick={() => void open(false)}>{CHAT.termRestart}</button>
          {kind === 'claude' && <button onClick={() => void open(true)}>{CHAT.termResume}</button>}
        </>}
      </div>
      <Confirm open={confirmKill} title={CHAT.termKillTitle} body={CHAT.termKillBody} confirmLabel={CHAT.termKill} danger
        onConfirm={() => { setConfirmKill(false); if (idRef.current) void window.knuaf.term.kill(idRef.current) }}
        onCancel={() => setConfirmKill(false)} />
    </div>
  )
}
