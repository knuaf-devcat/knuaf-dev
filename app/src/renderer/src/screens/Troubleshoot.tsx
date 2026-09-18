import { useEffect, useState } from 'react'
import { useProject } from '../store/project'
import { rpc, describeError, RpcFailure } from '../rpc'
import { Confirm } from '../components/Confirm'
import { RunLog, type LogLine } from '../components/RunLog'
import type { HistoryRow, LockInfo } from '../../../shared/types'

export function Troubleshoot() {
  const { root, hasProject, status, refresh, refreshSidecar, sidecar, open } = useProject()
  const [doc, setDoc] = useState<Record<string, any> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'unlock' | 'restore' | 'init'; rev?: number } | null>(null)
  const [depsLines, setDepsLines] = useState<LogLine[]>([])
  const [depsBusy, setDepsBusy] = useState(false)
  const load = async () => {
    if (!root) return
    setErr(null)
    try { setDoc(await rpc.doctor(root)) } catch (e) { setErr(describeError(e)) }
  }
  useEffect(() => { void load(); void refreshSidecar() }, [root, status?.revision])
  if (!root) return <div><h1>문제 해결</h1><p className="muted">먼저 홈에서 폴더를 여세요.</p></div>
  const lock: LockInfo | undefined = doc?.lock
  const hist: HistoryRow[] = Array.isArray(doc?.snapshots) ? doc!.snapshots : []
  const deps = doc?.deps
  const act = async () => {
    if (!confirm) return
    const c = confirm; setConfirm(null); setErr(null); setMsg(null)
    try {
      if (c.kind === 'unlock') { const r = await rpc.unlock(root); setMsg('잠금을 해제했습니다.' + (r.leftover ? ' 남은 파일: ' + r.leftover : '')) }
      if (c.kind === 'restore' && c.rev != null && status) { const r = await rpc.restore(root, c.rev, status.revision); setMsg(`개정 ${r.restored_from}의 정본을 개정 ${r.revision}으로 복원했습니다. 복원 직전 상태는 ${r.pre_restore_snapshot}에 저장됨.`) }
      if (c.kind === 'init') { await rpc.init(root); setMsg('빈 정본(project.json)을 만들었습니다.'); await open(root); return }
      await refresh(); await load()
    } catch (e) { setErr(describeError(e)) }
  }
  const ensureDeps = async () => {
    setDepsBusy(true); setDepsLines([]); setErr(null); setMsg(null)
    const r = await window.knuaf.depsEnsure(root, (event, data) => { if (event === 'log') setDepsLines((l) => [...l.slice(-399), data as LogLine]) })
    setDepsBusy(false)
    if (r.error) setErr(describeError(new RpcFailure(r.error)))
    else if (r.result.ok) { setMsg('패키지를 프로젝트 폴더의 .venv에 준비했습니다.'); await refreshSidecar(); await load() }
    else setErr('패키지 준비 실패: ' + (r.result.block_reason ?? r.result.stderr.slice(-400)))
  }
  const [kordocBusy, setKordocBusy] = useState(false)
  const [kordocLines, setKordocLines] = useState<LogLine[]>([])
  const prepareKordoc = async () => {
    setKordocBusy(true); setKordocLines([]); setErr(null); setMsg(null)
    try {
      const env = await rpc.script('kordoc.ensure', { root }, (event, data) => { if (event === 'log') setKordocLines((l) => [...l.slice(-399), data as LogLine]) })
      if (env.ok) setMsg('문서 읽기 도구가 준비되었습니다.'); else setErr('도구 준비 실패: ' + (env.block_reason ?? env.stderr.slice(-300)))
      await load()
    } catch (e) { setErr(describeError(e)) } finally { setKordocBusy(false) }
  }
  const verdictText: Record<string, string> = {
    none: '잠금 없음', live: '실행 중인 작업이 잠금을 쥐고 있음 — 기다리거나 그 작업을 확인하세요', stale_releasable: '남은 잠금 — 같은 기기에서 종료된 작업의 것이라 해제할 수 있음',
    foreign_host: '다른 기기의 잠금 — 그 기기에서 확인해야 함', ambiguous: '소유 기록이 불명확 — 보존함(직접 확인 필요)'
  }
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}><h1>문제 해결</h1><button onClick={load}>다시 진단</button></div>
      {err && <div className="banner bad">{err}</div>}
      {msg && <div className="banner info">{msg}</div>}
      {!hasProject && (
        <div className="banner warn">
          이 폴더에는 아직 <code>project.json</code>이 없습니다. 보통 에이전트가 "시작하기"로 만듭니다. 새 빈 폴더가 확실하면 여기서 만들 수도 있습니다.
          <div style={{ marginTop: 8 }}><button onClick={() => setConfirm({ kind: 'init' })}>빈 정본 만들기</button></div>
        </div>
      )}

      <h2>Python과 패키지</h2>
      <div className="card">
        <div>실행기: <code>{sidecar?.python}</code> <span className="pill">{sidecar?.kind}</span> {sidecar?.running ? <span className="pill pass">실행 중</span> : <span className="pill fail">꺼짐</span>}</div>
        {deps && !deps.error && (
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>패키지</th><th>용도</th><th>상태</th></tr></thead>
            <tbody>{(deps.dependencies ?? []).map((d: any) => <tr key={d.dist}><td><code>{d.dist}</code></td><td>{d.purpose}</td><td><span className={'pill ' + (d.status === 'installed' ? 'pass' : 'fail')}>{d.status}</span></td></tr>)}</tbody>
          </table>
        )}
        {deps?.error && <div className="muted">{deps.error}</div>}
        <div className="row" style={{ marginTop: 8 }}>
          <span className={'pill ' + (deps?.ready ? 'pass' : 'fail')}>{deps?.ready ? '준비됨' : '준비 필요'}</span>
          <button className="primary" disabled={depsBusy} onClick={ensureDeps}>{depsBusy ? '준비 중…' : '패키지 준비(.venv)'}</button>
          <span className="muted">프로젝트 폴더 안 <code>.venv</code>에만 설치하며 전역 Python은 건드리지 않습니다.</span>
        </div>
        <RunLog lines={depsLines} />
      </div>

      <h2>쓰기 잠금</h2>
      <div className="card">
        {lock && (
          <div>
            <div><strong>{verdictText[lock.verdict] ?? lock.verdict}</strong></div>
            {lock.owner && <div className="muted" style={{ fontSize: 12 }}>pid {String(lock.owner.pid)} · host {String(lock.owner.host)} · {lock.age_seconds != null ? `${Math.round(lock.age_seconds / 60)}분 전 획득` : '획득 시각 없음'} · 프로세스 {lock.pid_alive === null ? '판정 불가' : lock.pid_alive ? '살아 있음' : '종료됨'}</div>}
            <div style={{ marginTop: 8 }}><button className="danger" disabled={lock.verdict !== 'stale_releasable'} onClick={() => setConfirm({ kind: 'unlock' })}>잠금 해제</button></div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{lock.notice}</div>
          </div>
        )}
      </div>

      <h2>정본 스냅샷</h2>
      <div className="card">
        <p className="muted">저장(apply)마다 직전 정본이 <code>migration/revision-N.json</code>에 남습니다. 복원은 새 개정으로 기록되며 절 파일·원문·build/는 건드리지 않습니다.</p>
        <table>
          <thead><tr><th>개정</th><th>요청</th><th>스냅샷</th><th /></tr></thead>
          <tbody>
            {hist.map((h) => (
              <tr key={h.revision}>
                <td>{h.revision}{h.current ? ' (현재)' : ''}</td><td><code>{h.request_id ?? '—'}</code></td>
                <td>{h.current ? '—' : h.snapshot_ok ? <span className="pill pass">해시 일치</span> : <span className="pill fail">없음/불일치</span>}</td>
                <td>{!h.current && h.snapshot_ok && <button onClick={() => setConfirm({ kind: 'restore', rev: h.revision })}>이 개정으로 복원</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>남은 임시 파일</h2>
      <div className="card">
        {(doc?.gg?.orphan_files ?? []).length === 0 ? <span className="muted">없음</span> : ((doc?.gg?.orphan_files ?? []) as string[]).map((p) => <div key={p} className="row"><code>{p}</code><button onClick={() => window.knuaf.reveal(p)}>보기</button></div>)}
        <div className="muted" style={{ fontSize: 12 }}>다른 작성자의 것일 수 있어 앱이 지우지 않습니다.</div>
      </div>

      <h2>문서 읽기 도구(Kordoc)</h2>
      <div className="card">
        {doc?.kordoc && !doc.kordoc.error ? <div>CLI: <code>{doc.kordoc.cli_path ?? '없음'}</code> · 캐시 {doc.kordoc.cache_present ? '있음' : '없음'} (<code>{doc.kordoc.cache_dir}</code>)</div> : <div className="muted">{doc?.kordoc?.error}</div>}
        <div className="row" style={{ marginTop: 8 }}>
          <button disabled={kordocBusy || !!doc?.kordoc?.cli_path} onClick={prepareKordoc}>{kordocBusy ? '준비 중…' : '도구 준비'}</button>
          <span className="muted" style={{ fontSize: 12 }}>문서를 읽는 데 필요한 도구를 준비할게요. 처음 한 번은 시간이 조금 걸릴 수 있어요.</span>
        </div>
        <RunLog lines={kordocLines} />
      </div>

      <Confirm open={confirm?.kind === 'unlock'} title="잠금 해제" body={<p>같은 기기에서 이미 종료된 작업의 잠금만 해제합니다. 다른 창에서 에이전트가 이 폴더에 저장 중이 아닌지 확인하셨나요?</p>} confirmLabel="해제" danger onConfirm={act} onCancel={() => setConfirm(null)} />
      <Confirm open={confirm?.kind === 'restore'} title={`개정 ${confirm?.rev}로 복원`} body={<p><b>현재 상태를 먼저 저장합니다.</b> 그다음 project.json만 개정 {confirm?.rev} 시점으로 되돌리고 새 개정 번호를 붙입니다. 절 파일과 발행물은 그대로입니다.</p>} confirmLabel="복원" danger onConfirm={act} onCancel={() => setConfirm(null)} />
      <Confirm open={confirm?.kind === 'init'} title="빈 정본 만들기" body={<p>이 폴더에 새 <code>project.json</code>을 만듭니다. 기존 정본이 있으면 만들지 않습니다.</p>} onConfirm={act} onCancel={() => setConfirm(null)} />
    </div>
  )
}
