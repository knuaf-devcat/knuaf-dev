import { useEffect, useState } from 'react'
import { useProject } from '../store/project'
import { rpc } from '../rpc'
import { Disclosure } from '../components/Disclosure'
import { Feedback } from '../components/Feedback'
import { Confirm } from '../components/Confirm'
import { Badge, StatusBadge } from '../components/Badge'
import { ProgressPanel } from '../components/ProgressPanel'
import { useRunner } from '../components/useRunner'
import { Icon } from '../components/Icon'
import { COMPLETION, EMPTY, KORDOC_SENTENCE, LOCK_VERDICT_COPY, describeError, relativeTime, type DescribedError } from '../copy'
import type { HistoryRow, LockInfo } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'

/**
 * The five troubleshooting 펼침들, embedded in 설정 > 문제 해결 (03-화면/08).
 * Failure feedback deep-links land on `data-preset="fix:<id>"`.
 */
export function TroubleshootSections() {
  const { root, hasProject, status, refresh, refreshSidecar, refreshDeps, sidecar, open } = useProject(useShallow((s) => ({ root: s.root, hasProject: s.hasProject, status: s.status, refresh: s.refresh, refreshSidecar: s.refreshSidecar, refreshDeps: s.refreshDeps, sidecar: s.sidecar, open: s.open })))
  const [doc, setDoc] = useState<Record<string, any> | null>(null)
  const [err, setErr] = useState<DescribedError | null>(null)
  const [msg, setMsg] = useState<{ title: string; body?: string } | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'unlock' | 'restore' | 'init'; rev?: number } | null>(null)
  const deps = useRunner()
  const kordoc = useRunner()
  const load = async () => {
    if (!root) return
    setErr(null)
    try { setDoc(await rpc.doctor(root)) } catch (e) { setErr(describeError(e)) }
  }
  useEffect(() => { void load(); void refreshSidecar() }, [root, status?.revision])
  if (!root) return <div className="caption">먼저 "내 논문"에서 폴더를 여세요.</div>
  const lock: LockInfo | undefined = doc?.lock
  const hist: HistoryRow[] = Array.isArray(doc?.snapshots) ? doc!.snapshots : []
  const depsInfo = doc?.deps
  const act = async () => {
    if (!confirm) return
    const c = confirm; setConfirm(null); setErr(null); setMsg(null)
    try {
      if (c.kind === 'unlock') { const r = await rpc.unlock(root); setMsg({ title: COMPLETION.unlocked, body: r.leftover ? '남은 파일: ' + r.leftover : undefined }) }
      if (c.kind === 'restore' && c.rev != null && status) { const r = await rpc.restore(root, c.rev, status.revision); setMsg({ title: COMPLETION.restored, body: `${r.restored_from}번째 기록의 정본을 ${r.revision}번째 기록으로 되돌렸어요. 복원 직전 상태는 ${r.pre_restore_snapshot}에 남아 있어요.` }) }
      if (c.kind === 'init') { await rpc.init(root); setMsg({ title: COMPLETION.init_done }); await open(root); return }
      await refresh(); await load()
    } catch (e) { setErr(describeError(e)) }
  }
  const ensureDeps = async () => {
    setErr(null); setMsg(null)
    const env = await deps.runDeps(root)
    if (env?.ok) { setMsg({ title: COMPLETION.deps_ready, body: '프로젝트 폴더의 .venv에 설치했어요.' }); await refreshSidecar(); await refreshDeps(); await load() }
    else if (env) setErr(describeError({ code: 'business_rule', message: env.block_reason ?? env.stderr.slice(-300) }))
  }
  const prepareKordoc = async () => {
    setErr(null); setMsg(null)
    const env = await kordoc.run('kordoc.ensure', { root })
    if (env?.ok) { setMsg({ title: COMPLETION.kordoc_ready }); await load() }
    else if (env) setErr(describeError({ code: 'business_rule', message: env.block_reason ?? env.stderr.slice(-300) }))
  }
  const verdict = lock ? LOCK_VERDICT_COPY[lock.verdict] : null
  const orphans: string[] = doc?.gg?.orphan_files ?? []
  return (
    <div>
      <div className="row" style={{ marginBottom: 'var(--sp-3)' }}>
        <button className="quiet" onClick={load}><Icon name="refresh" size={16} /> 다시 진단</button>
      </div>
      {err && <Feedback kind={err.kind} title={err.title} body={err.action} details={<code>{err.raw}</code>} />}
      {msg && <Feedback kind="completion" title={msg.title} body={msg.body} />}
      {!hasProject && <Feedback kind="warning" title="이 폴더에는 아직 정본(project.json)이 없어요" body="보통 도우미가 '시작하기'로 만들어요. 새 빈 폴더가 확실하면 여기서 만들 수도 있어요." actions={<button onClick={() => setConfirm({ kind: 'init' })}>빈 정본 만들기</button>} />}

      <Disclosure label="준비 상태" preset="fix:deps">
        <div className="card-head"><h2>준비 상태</h2>{depsInfo && <StatusBadge status={depsInfo.ready ? 'pass' : 'blocked'} label={depsInfo.ready ? '준비됨' : '준비 필요'} />}</div>
        <div className="caption">실행기 <code>{sidecar?.python}</code> <Badge label={sidecar?.kind ?? ''} /> {sidecar?.running ? <Badge tone="pass" label="실행 중" /> : <Badge tone="fail" label="꺼짐" />}</div>
        {depsInfo && !depsInfo.error && (
          <table style={{ marginTop: 'var(--sp-3)' }}>
            <thead><tr><th>패키지</th><th>용도</th><th>상태</th></tr></thead>
            <tbody>{(depsInfo.dependencies ?? []).map((d: any) => <tr key={d.dist}><td><code>{d.dist}</code></td><td>{d.purpose}</td><td><StatusBadge status={d.status} /></td></tr>)}</tbody>
          </table>
        )}
        <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
          <button className="primary" disabled={deps.busy} onClick={ensureDeps}>{deps.busy ? '준비 중…' : '패키지 준비'}</button>
          <span className="caption">프로젝트 폴더 안 <code>.venv</code>에만 설치해요. 전역 Python은 건드리지 않아요.</span>
        </div>
        <ProgressPanel busy={deps.busy} phase={deps.phase} elapsedMs={deps.elapsedMs} lines={deps.lines} onCancel={deps.cancel} />
      </Disclosure>

      <Disclosure label="쓰기 잠금" preset="fix:lock">
        <div className="card-head"><h2>쓰기 잠금</h2>{lock && <StatusBadge status={lock.verdict === 'none' ? 'pass' : lock.verdict === 'stale_releasable' ? 'warning' : lock.verdict === 'live' ? 'blocked' : 'fail'} label={verdict?.title ?? lock.verdict} />}</div>
        {lock && verdict && (
          <div>
            <div>{verdict.detail}</div>
            {lock.owner && <div className="caption">pid {String(lock.owner.pid)} · {String(lock.owner.host)} · {lock.acquired_at ? relativeTime(lock.acquired_at * 1000) + ' 획득' : '획득 시각 없음'} · 프로세스 {lock.pid_alive === null ? '판정 불가' : lock.pid_alive ? '살아 있음' : '종료됨'}</div>}
            <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
              <button className="danger" disabled={lock.verdict !== 'stale_releasable'} onClick={() => setConfirm({ kind: 'unlock' })}>잠금 해제</button>
              {lock.verdict !== 'stale_releasable' && lock.present && <span className="caption">같은 기기에서 종료된 작업의 잠금만 해제할 수 있어요.</span>}
            </div>
          </div>
        )}
      </Disclosure>

      <Disclosure label="이전 원고 스냅샷" preset="fix:snapshots">
        <div className="card-head"><h2>이전 원고 스냅샷</h2><Badge label={`${Math.max(hist.length - 1, 0)}개`} /></div>
        <p className="caption">저장할 때마다 직전 정본이 <code>migration/revision-N.json</code>에 남아요. 복원은 새 개정으로 기록되고 장 파일·원문·build 폴더는 그대로예요.</p>
        {hist.length <= 1 ? <div className="caption">{EMPTY.snapshots.title}</div> : (
          <div className="list">
            {hist.map((h) => (
              <div key={h.revision} className="item">
                <div className="head"><span><strong>{h.revision}번째 기록</strong>{h.current ? <span className="caption"> · 현재</span> : null} <code className="muted">{h.request_id ?? ''}</code></span>
                  <span className="row">{h.current ? null : h.snapshot_ok ? <StatusBadge status="pass" label="해시 일치" /> : <StatusBadge status="fail" label="없음/불일치" />}{!h.current && h.snapshot_ok && <button onClick={() => setConfirm({ kind: 'restore', rev: h.revision })}>이 기록으로 복원</button>}</span></div>
              </div>
            ))}
          </div>
        )}
      </Disclosure>

      <Disclosure label="남은 임시 파일" preset="fix:orphans">
        <div className="card-head"><h2>남은 임시 파일</h2><Badge label={`${orphans.length}개`} /></div>
        {orphans.length === 0 ? <div className="caption">{EMPTY.orphans.title}</div> : orphans.map((p) => <div key={p} className="row"><code>{p}</code><button className="quiet" onClick={() => window.knuaf.reveal(p)}>보기</button></div>)}
        <div className="caption" style={{ marginTop: 'var(--sp-2)' }}>다른 작성자의 것일 수 있어 앱이 지우지 않아요.</div>
      </Disclosure>

      <Disclosure label="문서 읽기 도구" preset="fix:kordoc">
        <div className="card-head"><h2>문서 읽기 도구</h2>{doc?.kordoc && !doc.kordoc.error && <StatusBadge status={doc.kordoc.cli_path ? 'pass' : 'blocked'} label={doc.kordoc.cli_path ? '준비됨' : '없음'} />}</div>
        {doc?.kordoc && !doc.kordoc.error && <div className="caption">{doc.kordoc.cli_path ? <code>{doc.kordoc.cli_path}</code> : '아직 없어요.'} · 캐시 {doc.kordoc.cache_present ? '있음' : '없음'}</div>}
        <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
          <button disabled={kordoc.busy || !!doc?.kordoc?.cli_path} onClick={prepareKordoc}>{kordoc.busy ? '준비 중…' : '도구 준비'}</button>
          <span className="caption">{KORDOC_SENTENCE}</span>
        </div>
        <ProgressPanel busy={kordoc.busy} phase={kordoc.phase} elapsedMs={kordoc.elapsedMs} lines={kordoc.lines} onCancel={kordoc.cancel} />
      </Disclosure>

      <Confirm open={confirm?.kind === 'unlock'} title="잠금 해제" body={<p>같은 기기에서 이미 종료된 작업의 잠금만 해제해요. 다른 창에서 도우미가 이 폴더에 저장 중이 아닌지 확인하셨나요?</p>} confirmLabel="해제" danger onConfirm={act} onCancel={() => setConfirm(null)} />
      <Confirm open={confirm?.kind === 'restore'} title={`${confirm?.rev}번째 기록으로 복원`} body={<p><b>현재 상태를 먼저 저장해요.</b> 그다음 정본만 {confirm?.rev}번째 기록 시점으로 되돌리고 새 기록 번호를 붙여요. 장 파일과 발행물은 그대로예요.</p>} confirmLabel="복원" danger onConfirm={act} onCancel={() => setConfirm(null)} />
      <Confirm open={confirm?.kind === 'init'} title="빈 정본 만들기" body={<p>이 폴더에 새 정본을 만들어요. 기존 정본이 있으면 만들지 않아요.</p>} onConfirm={act} onCancel={() => setConfirm(null)} />
    </div>
  )
}
