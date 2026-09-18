import { useEffect, useState } from 'react'
import { useProject } from '../store/project'

export function SettingsScreen() {
  const { settings, loadSettings, sidecar, refreshSidecar, logs, clearLogs } = useProject()
  const [override, setOverride] = useState('')
  useEffect(() => { setOverride(settings?.python_override ?? ''); void refreshSidecar() }, [settings])
  const save = async () => { await window.knuaf.setSettings({ python_override: override || null }); await loadSettings(); await window.knuaf.sidecarRestart(); await refreshSidecar() }
  return (
    <div>
      <h1>설정</h1>
      <div className="card">
        <h3>Python 실행기</h3>
        <div>현재: <code>{sidecar?.python ?? '—'}</code> <span className="pill">{sidecar?.kind}</span></div>
        <div className="muted" style={{ fontSize: 12 }}>기본 실행기: <code>{(sidecar as any)?.basePython ?? '—'}</code> · 오프라인 휠: <code>{(sidecar as any)?.wheelhouse ?? '없음'}</code></div>
        <div className="field" style={{ marginTop: 8 }}><span>직접 지정(고급)</span><input value={override} onChange={(e) => setOverride(e.target.value)} placeholder="/usr/local/bin/python3.12 (비우면 자동)" /><button onClick={save}>적용·재시작</button></div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3>최근 폴더</h3>
        <button onClick={async () => { await window.knuaf.setSettings({ recent: [] }); await loadSettings() }}>목록 지우기</button>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}><h3>실행기 로그</h3><button onClick={clearLogs}>지우기</button></div>
        <div className="log">{logs.length === 0 ? <span className="muted">없음</span> : logs.map((l, i) => <div key={i} className={l.stream}>{l.line}</div>)}</div>
      </div>
      <p className="muted" style={{ marginTop: 12 }}>이 앱은 아무것도 기기 밖으로 보내지 않습니다. 원본·개인 자료는 작업 폴더에만 있습니다.</p>
    </div>
  )
}
