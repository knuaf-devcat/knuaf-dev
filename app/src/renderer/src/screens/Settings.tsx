import { useEffect, useRef, useState } from 'react'
import { useProject } from '../store/project'
import { useChat, resolveChatMode, type ChatMode } from '../store/chat'
import { Toolbar } from '../components/Toolbar'
import { Badge } from '../components/Badge'
import { Disclosure } from '../components/Disclosure'
import { HelperSheet } from '../components/HelperSheet'
import { OutputsTools } from './Outputs'
import { TroubleshootSections } from './Troubleshoot'
import { HELPER, PRIVACY_NOTE, SETTINGS } from '../copy'
import { useShallow } from 'zustand/react/shallow'

export function SettingsScreen() {
  const { root, settings, loadSettings, sidecar, refreshSidecar, logs, clearLogs, openHelper, open, loading, settingsFocus, clearSettingsFocus } = useProject(useShallow((s) => ({ root: s.root, settings: s.settings, loadSettings: s.loadSettings, sidecar: s.sidecar, refreshSidecar: s.refreshSidecar, logs: s.logs, clearLogs: s.clearLogs, openHelper: s.openHelper, open: s.open, loading: s.loading, settingsFocus: s.settingsFocus, clearSettingsFocus: s.clearSettingsFocus })))
  const setMode = useChat((s) => s.setMode)
  const [override, setOverride] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [info, setInfo] = useState<{ version: string; packaged: boolean; logs: string; electron: string } | null>(null)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => { void window.knuaf.appInfo().then(setInfo) }, [])
  useEffect(() => { setOverride(settings?.python_override ?? ''); void refreshSidecar() }, [settings])
  /** Failure deep links: open the matching 펼침, then clear so it behaves like a normal disclosure. */
  useEffect(() => {
    if (!settingsFocus) return
    const el = body.current?.querySelector<HTMLDetailsElement>(`details[data-preset="${CSS.escape(settingsFocus)}"]`)
    if (el) { el.open = true; el.scrollIntoView({ block: 'start' }) }
    clearSettingsFocus()
  }, [settingsFocus])
  const save = async () => { await window.knuaf.setSettings({ python_override: override || null }); await loadSettings(); await window.knuaf.sidecarRestart(); await refreshSidecar() }
  const mode: ChatMode = resolveChatMode(null, settings)
  const pickHelper = async (m: ChatMode) => { await window.knuaf.setSettings({ helper_mode: m }); await loadSettings(); setMode(null) }
  const pickFolder = async () => { const d = await window.knuaf.pickFolder(); if (d) void open(d) }
  const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
  return (
    <div ref={body}>
      <Toolbar title={SETTINGS.title} />

      <section className="card">
        <div className="card-head"><h2>{SETTINGS.folderTitle}</h2></div>
        {root && <div className="row"><strong>{base(root)}</strong><span className="caption">{root}</span></div>}
        <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
          <button onClick={pickFolder} disabled={loading}>{SETTINGS.folderOpenOther}</button>
        </div>
        {(settings?.recent.length ?? 0) > 0 && (
          <div className="row" style={{ marginTop: 'var(--sp-2)', flexWrap: 'wrap' }}>
            <span className="caption">최근:</span>
            {settings!.recent.map((r) => <button key={r.root} className="quiet" onClick={() => void open(r.root)} disabled={loading || r.root === root}>{base(r.root)}</button>)}
            <button className="quiet" onClick={async () => { await window.knuaf.setSettings({ recent: [] }); await loadSettings() }}>{SETTINGS.folderRecentClear}</button>
          </div>
        )}
        {(settings?.trusted_roots?.length ?? 0) > 0 && (
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <div className="caption"><strong>{SETTINGS.trustedTitle}</strong> — {SETTINGS.trustedBody}</div>
            <div className="row" style={{ marginTop: 'var(--sp-2)', flexWrap: 'wrap' }}>
              {settings!.trusted_roots!.map((t) => (
                <button key={t} className="quiet" title={t}
                  onClick={async () => { await window.knuaf.trustProject(t, false); await loadSettings() }}>
                  {base(t)} — {SETTINGS.trustedOff}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* 폴더를 경로로 여는 유일한 입력칸 — 일반 흐름은 폴더 선택 대화상자·드롭·최근 카드(03-화면/01 결정). */}
        <Disclosure label={SETTINGS.folderAdvanced} preset="folder:path">
          <div className="row">
            <input aria-label={SETTINGS.folderPathLabel} style={{ minWidth: 360 }} value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="/Users/…/논문 작업" onKeyDown={(e) => { if (e.key === 'Enter' && folderPath) void open(folderPath) }} />
            <button onClick={() => folderPath && open(folderPath)} disabled={loading || !folderPath}>{SETTINGS.folderPathOpen}</button>
          </div>
        </Disclosure>
      </section>

      <section className="card">
        <div className="card-head"><h2>{SETTINGS.helperTitle}</h2></div>
        {/* 내 논문은 항상 앱 채팅 — 여기서 고르는 것은 어느 도우미인지뿐. */}
        <div className="caption" style={{ marginBottom: 'var(--sp-1)' }}>{SETTINGS.helperChatWhich}</div>
        <label className="opt-card">
          <input type="radio" name="helper-chat" checked={mode === 'codex-chat'} onChange={() => void pickHelper('codex-chat')} />
          <span>{SETTINGS.helperChatCodex}</span>
        </label>
        <label className="opt-card">
          <input type="radio" name="helper-chat" checked={mode === 'claude-chat'} onChange={() => void pickHelper('claude-chat')} />
          <span>{SETTINGS.helperChatClaude}</span>
        </label>
        <p className="caption">{SETTINGS.helperChatNote}</p>
        <div className="row" style={{ marginTop: 'var(--sp-3)' }}><button onClick={() => void openHelper()}>{HELPER.button}</button></div>
      </section>

      <section className="card">
        <div className="card-head"><h2>{SETTINGS.troubleTitle}</h2></div>
        <TroubleshootSections />
      </section>

      <section className="card">
        <div className="card-head"><h2>{SETTINGS.toolsTitle}</h2><span className="caption">{SETTINGS.toolsNote}</span></div>
        <OutputsTools />
      </section>

      <section className="card">
        <div className="card-head"><h2>{SETTINGS.pythonTitle}</h2>{sidecar && <Badge label={sidecar.kind} />}</div>
        <div className="caption">현재 <code>{sidecar?.python ?? '—'}</code></div>
        <Disclosure label="고급">
          <div className="caption">기본 실행기 <code>{(sidecar as any)?.basePython ?? '—'}</code> · 오프라인 휠 <code>{(sidecar as any)?.wheelhouse ?? '없음'}</code></div>
          <div className="row" style={{ marginTop: 'var(--sp-2)' }}><input aria-label="Python 경로" style={{ minWidth: 360 }} value={override} onChange={(e) => setOverride(e.target.value)} placeholder="/usr/local/bin/python3.12 (비우면 자동)" /><button onClick={save}>적용·재시작</button></div>
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <div className="row"><span className="caption">실행기 로그</span><button className="quiet" onClick={clearLogs}>지우기</button></div>
            <div className="log">{logs.length === 0 ? <span className="muted">없음</span> : logs.map((l, i) => <div key={i} className={l.stream}>{l.line}</div>)}</div>
          </div>
        </Disclosure>
      </section>

      <section className="card">
        <div className="card-head"><h2>{SETTINGS.appInfoTitle}</h2>{info && <Badge label={`버전 ${info.version}`} />}</div>
        <div className="caption">한농대 창업논문 헬퍼{info ? ` · Electron ${info.electron} · ${info.packaged ? '설치판' : '개발 모드'}` : ''}</div>
        <div className="row" style={{ marginTop: 'var(--sp-2)' }}>{info && <button onClick={() => window.knuaf.openPath(info.logs)}>로그 폴더 열기</button>}</div>
        <p className="caption" style={{ marginTop: 'var(--sp-3)' }}>{PRIVACY_NOTE}</p>
      </section>

      <HelperSheet />
    </div>
  )
}
