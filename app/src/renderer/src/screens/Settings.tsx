import { useEffect, useState } from 'react'
import { useProject } from '../store/project'
import { Toolbar } from '../components/Toolbar'
import { Badge } from '../components/Badge'
import { Disclosure } from '../components/Disclosure'
import { PRIVACY_NOTE, SCREEN_INTRO } from '../copy'

export function SettingsScreen() {
  const { settings, loadSettings, sidecar, refreshSidecar, logs, clearLogs } = useProject()
  const [override, setOverride] = useState('')
  const [info, setInfo] = useState<{ version: string; packaged: boolean; logs: string; electron: string } | null>(null)
  useEffect(() => { void window.knuaf.appInfo().then(setInfo) }, [])
  useEffect(() => { setOverride(settings?.python_override ?? ''); void refreshSidecar() }, [settings])
  const save = async () => { await window.knuaf.setSettings({ python_override: override || null }); await loadSettings(); await window.knuaf.sidecarRestart(); await refreshSidecar() }
  return (
    <div>
      <Toolbar title="설정" />
      <p className="intro">{SCREEN_INTRO.settings}</p>
      <section className="card">
        <div className="card-head"><h2>Python 실행기</h2>{sidecar && <Badge label={sidecar.kind} />}</div>
        <div className="caption">현재 <code>{sidecar?.python ?? '—'}</code></div>
        <Disclosure label="고급">
          <div className="caption">기본 실행기 <code>{(sidecar as any)?.basePython ?? '—'}</code> · 오프라인 휠 <code>{(sidecar as any)?.wheelhouse ?? '없음'}</code></div>
          <div className="row" style={{ marginTop: 'var(--sp-2)' }}><input aria-label="Python 경로" style={{ minWidth: 360 }} value={override} onChange={(e) => setOverride(e.target.value)} placeholder="/usr/local/bin/python3.12 (비우면 자동)" /><button onClick={save}>적용·재시작</button></div>
        </Disclosure>
      </section>
      <section className="card">
        <div className="card-head"><h2>최근 폴더</h2></div>
        <button onClick={async () => { await window.knuaf.setSettings({ recent: [] }); await loadSettings() }}>목록 지우기</button>
      </section>
      <section className="card">
        <div className="card-head"><h2>실행기 로그</h2><button className="quiet" onClick={clearLogs}>지우기</button></div>
        <Disclosure label={`${logs.length}줄`}><div className="log">{logs.length === 0 ? <span className="muted">없음</span> : logs.map((l, i) => <div key={i} className={l.stream}>{l.line}</div>)}</div></Disclosure>
      </section>
      <section className="card">
        <div className="card-head"><h2>앱 정보</h2>{info && <Badge label={`버전 ${info.version}`} />}</div>
        <div className="caption">knuaf-doc 동반 앱{info ? ` · Electron ${info.electron} · ${info.packaged ? '설치판' : '개발 모드'}` : ''}</div>
        <div className="row" style={{ marginTop: 'var(--sp-2)' }}>{info && <button onClick={() => window.knuaf.openPath(info.logs)}>로그 폴더 열기</button>}</div>
        <p className="caption" style={{ marginTop: 'var(--sp-3)' }}>{PRIVACY_NOTE}</p>
      </section>
    </div>
  )
}
