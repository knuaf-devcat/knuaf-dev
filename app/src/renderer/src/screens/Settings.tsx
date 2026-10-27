import { useEffect, useRef, useState } from 'react'
import { useProject } from '../store/project'
import type { AppInfo } from '../../../shared/types'
import { useChat, chatProvider, resolveChatMode, type ChatMode } from '../store/chat'
import { Badge } from '../components/Badge'
import { Disclosure } from '../components/Disclosure'
import { HelperSheet } from '../components/HelperSheet'
import { Feedback } from '../components/Feedback'
import { RuntimeSetup } from '../components/RuntimeFix'
import { OutputsTools } from './Outputs'
import { TroubleshootSections } from './Troubleshoot'
import { HELPER, PRIVACY_NOTE, SETTINGS, type DescribedError } from '../copy'
import { useShallow } from 'zustand/react/shallow'
import { APP_NAME } from '../../../shared/name'

export function SettingsScreen() {
  const { root, settings, loadSettings, sidecar, refreshSidecar, logs, clearLogs, openHelper, open, loading, settingsFocus, clearSettingsFocus } = useProject(useShallow((s) => ({ root: s.root, settings: s.settings, loadSettings: s.loadSettings, sidecar: s.sidecar, refreshSidecar: s.refreshSidecar, logs: s.logs, clearLogs: s.clearLogs, openHelper: s.openHelper, open: s.open, loading: s.loading, settingsFocus: s.settingsFocus, clearSettingsFocus: s.clearSettingsFocus })))
  const setMode = useChat((s) => s.setMode)
  const [override, setOverride] = useState('')
  const [folderPath, setFolderPath] = useState('')
  // GUI-04: 폴더 열기 실패는 이 화면에서 한 번만 알린다 — 전역 error 에 두면
  // 내 논문/점검 화면에도 같은 오류가 떠서 실패한 자리가 어디인지 흐려진다.
  const [openErr, setOpenErr] = useState<DescribedError | null>(null)
  const tryOpen = async (p: string) => { setOpenErr(null); setOpenErr(await open(p, { local: true })) }
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [buildCopy, setBuildCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
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
  const copyBuildInfo = async () => {
    if (!info) return
    try {
      await navigator.clipboard.writeText(`${info.buildDate} ${info.buildCommit}`)
      setBuildCopy('copied')
      window.setTimeout(() => setBuildCopy('idle'), 1500)
    } catch { setBuildCopy('failed') }
  }
  const mode: ChatMode = resolveChatMode(null, settings)
  /**
   * 여기서 고른 것이 **선택의 기록**이다. `helper_mode` 는 화면 기본값일 뿐이라
   * 그것만 저장하면 "고른 적 없음"과 "골라서 기본값과 같음"이 구별되지 않는다(IMPL-R1-02).
   */
  const pickHelper = async (m: ChatMode) => {
    await window.knuaf.setSettings({ helper_mode: m, provider_choice: { provider: chatProvider(m), at: new Date().toISOString() } })
    await loadSettings()
    setMode(null)
  }
  // 설정이 아직 안 읽혔거나 키가 없으면 '묻지 않기' — 디스크 기본값과 같은 쪽으로 읽는다.
  const permission: 'trust' | 'ask' = settings?.permission_mode === 'ask' ? 'ask' : 'trust'
  const pickPermission = async (m: 'trust' | 'ask') => { await window.knuaf.setSettings({ permission_mode: m }); await loadSettings() }
  const pickFolder = async () => { const d = await window.knuaf.pickFolder(); if (d) void tryOpen(d) }
  const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
  return (
    <div ref={body}>
      <section className="card">
        <div className="card-head"><h2>{SETTINGS.folderTitle}</h2></div>
        {root && <div className="row"><strong>{base(root)}</strong><span className="caption">{root}</span></div>}
        {openErr && (
          <Feedback kind={openErr.kind} title={openErr.title}
            body={`${openErr.action ? openErr.action + ' ' : ''}${root ? SETTINGS.folderKeptAfterFail(base(root)) : SETTINGS.folderNoneAfterFail}`}
            details={<code>{openErr.raw}</code>} />
        )}
        <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
          <button onClick={pickFolder} disabled={loading}>{SETTINGS.folderOpenOther}</button>
        </div>
        {(settings?.recent.length ?? 0) > 0 && (
          <div className="row" style={{ marginTop: 'var(--sp-2)', flexWrap: 'wrap' }}>
            <span className="caption">최근:</span>
            {settings!.recent.map((r) => <button key={r.root} className="quiet" onClick={() => void tryOpen(r.root)} disabled={loading || r.root === root}>{base(r.root)}</button>)}
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
            <input aria-label={SETTINGS.folderPathLabel} style={{ minWidth: 360 }} value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="/Users/…/논문 작업" onKeyDown={(e) => { if (e.key === 'Enter' && folderPath) void tryOpen(folderPath) }} />
            <button onClick={() => folderPath && void tryOpen(folderPath)} disabled={loading || !folderPath}>{SETTINGS.folderPathOpen}</button>
          </div>
        </Disclosure>
      </section>

      <section className="card">
        <div className="card-head"><h2>{SETTINGS.helperTitle}</h2></div>
        {/* 내 논문은 항상 앱 채팅 — 여기서 고르는 것은 어느 도우미인지뿐. */}
        <div className="caption" style={{ marginBottom: 'var(--sp-1)' }}>{SETTINGS.helperChatWhich}</div>
        <label className="opt-row">
          <input type="radio" name="helper-chat" checked={mode === 'codex-chat'} onChange={() => void pickHelper('codex-chat')} />
          <span>{SETTINGS.helperChatCodex}</span>
        </label>
        <label className="opt-row">
          <input type="radio" name="helper-chat" checked={mode === 'claude-chat'} onChange={() => void pickHelper('claude-chat')} />
          <span>{SETTINGS.helperChatClaude}</span>
        </label>
        <p className="caption">{SETTINGS.helperChatNote}</p>
        {/* 권한 묻기 기본값은 '묻지 않기'. 숨긴 기본값이 아니라 여기서 보이고 되돌릴 수 있어야 한다. */}
        <div className="caption" style={{ marginTop: 'var(--sp-4)', marginBottom: 'var(--sp-1)' }}>{SETTINGS.permissionWhich}</div>
        <label className="opt-row">
          <input type="radio" name="permission-mode" checked={permission === 'trust'} onChange={() => void pickPermission('trust')} />
          <span>{SETTINGS.permissionTrust}</span>
        </label>
        <label className="opt-row">
          <input type="radio" name="permission-mode" checked={permission === 'ask'} onChange={() => void pickPermission('ask')} />
          <span>{SETTINGS.permissionAsk}</span>
        </label>
        <p className="caption">{SETTINGS.permissionTradeoff}</p>
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
        {/* 상시 버튼(D8) — 오류 카드가 없어도 여기서 앱 전용 Python을 준비할 수 있다. */}
        <RuntimeSetup />
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
        <div className="caption">{APP_NAME} · 초기 베타{info ? ` · Electron ${info.electron} · ${info.packaged ? '설치판' : '개발 모드'}` : ''}</div>
        {info && <div className="row app-build-info" style={{ marginTop: 'var(--sp-2)' }}>
          <code title={`${info.buildDate} ${info.buildCommit}`}>빌드 {info.buildDate} · 커밋 {info.buildCommit}</code>
          <button className="quiet" onClick={() => void copyBuildInfo()} aria-label="빌드 정보 복사">{buildCopy === 'copied' ? '복사했어요' : '빌드 정보 복사'}</button>
          <button onClick={() => window.knuaf.openPath(info.logs)}>로그 폴더 열기</button>
          {buildCopy === 'failed' && <span role="alert" className="caption">복사하지 못했어요</span>}
        </div>}
        <p className="caption" style={{ marginTop: 'var(--sp-3)' }}>{PRIVACY_NOTE}</p>
      </section>

      <HelperSheet />
    </div>
  )
}
