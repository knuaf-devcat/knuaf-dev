import { useEffect, useState } from 'react'
import { useProject } from '../store/project'
import { rpc, describeError } from '../rpc'
import { EnvelopeView } from '../components/EnvelopeView'
import { RunLog, type LogLine } from '../components/RunLog'
import type { Envelope } from '../../../shared/types'

type Tab = 'export' | 'paper' | 'docx' | 'excel' | 'office' | 'tree'

function useRunner() {
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<LogLine[]>([])
  const [env, setEnv] = useState<Envelope | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const run = async (method: string, params: Record<string, unknown>) => {
    setBusy(true); setLines([]); setEnv(null); setErr(null)
    try {
      setEnv(await rpc.script(method, params, (event, data) => {
        if (event === 'log') setLines((l) => [...l.slice(-399), data as LogLine])
        if (event === 'progress') setLines((l) => [...l, { stream: 'progress', line: '· ' + JSON.stringify(data) }])
      }))
    } catch (e) { setErr(describeError(e)) } finally { setBusy(false) }
  }
  return { busy, lines, env, err, run }
}

/** Suggest a sibling path that does not exist yet (no overwrite, ever). */
function versioned(path: string, taken: (p: string) => boolean): string {
  if (!taken(path)) return path
  const m = path.match(/^(.*?)(?:-v(\d+))?(\.[^./\\]+)?$/)
  const base = m?.[1] ?? path, ext = m?.[3] ?? ''
  for (let i = 2; i < 100; i++) { const c = `${base}-v${i}${ext}`; if (!taken(c)) return c }
  return path
}

export function Outputs() {
  const { root, status, refresh } = useProject()
  const [tab, setTab] = useState<Tab>('export')
  const [tree, setTree] = useState<any>(null)
  const runner = useRunner()
  const [kind, setKind] = useState('review')
  const [exportResult, setExportResult] = useState<{ path: string } | null>(null)
  const [exportErr, setExportErr] = useState<string | null>(null)
  const [form, setForm] = useState<Record<string, string>>({ paper_in: 'paper-input.json', paper_out: 'build/검토전_본문.md', docx_in: 'build/본문_통합.md', docx_out: 'build/검토전_논문.docx', font: '신명조', xl_source: '', xl_map: 'build/template-review/source-map.json', xl_blank: 'build/template-review/blank-v1.xlsx', xl_values: '', xl_writemap: '', xl_filled: 'build/template-review/filled-v1.xlsx', xl_final: '', xl_receipts: '', of_input: '', of_out: 'build/native' })
  const existing = new Set<string>()
  tree?.revisions?.forEach((r: any) => r.kinds.forEach((k: any) => k.files.forEach((f: any) => existing.add(`build/${r.revision}/${k.kind}/${f.name}`))))
  tree?.files?.forEach((f: any) => existing.add('build/' + f.name))
  const loadTree = async () => { if (root) setTree(await rpc.buildTree(root)) }
  useEffect(() => { void loadTree() }, [root, runner.env, exportResult])
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  const pick = (k: string, filters: { name: string; extensions: string[] }[]) => async () => { const f = await window.knuaf.pickFile({ filters, defaultPath: root ?? undefined }); if (f) setForm({ ...form, [k]: f }) }
  const doExport = async () => {
    if (!root) return
    setExportErr(null); setExportResult(null)
    try { setExportResult(await rpc.export(root, kind)); await refresh() } catch (e) { setExportErr(describeError(e)) }
  }
  if (!root) return null
  const unverified = status ? status.gate.filter((r) => r.status !== 'pass' && r.severity === 'error') : []
  return (
    <div>
      <h1>산출물</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        {([['export', '검토본 내보내기'], ['paper', '논문 골격'], ['docx', 'DOCX 생성'], ['excel', '재무 엑셀'], ['office', 'Office 렌더'], ['tree', 'build/ 폴더']] as [Tab, string][]).map(([t, l]) => <button key={t} className={tab === t ? 'primary' : ''} onClick={() => setTab(t)}>{l}</button>)}
      </div>

      {tab === 'export' && (
        <div className="card">
          <p>현재 정본(개정 {status?.revision})의 본문을 <code>build/{status?.revision}/{kind}/</code>에 발행합니다. 기존 발행물은 덮어쓰지 않습니다.</p>
          <div className="row">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="draft">검토전 초안 (draft)</option><option value="review">검토용 (review)</option><option value="submission_candidate">검사완료·교수확인전 (submission_candidate)</option>
            </select>
            <button className="primary" onClick={doExport}>발행하기</button>
          </div>
          {exportErr && <div className="banner bad" style={{ marginTop: 10 }}>{exportErr}</div>}
          {exportResult && (
            <div className="banner info" style={{ marginTop: 10 }}>
              <div className="row"><strong>발행됨</strong><code>{exportResult.path}</code><button onClick={() => window.knuaf.reveal(exportResult.path)}>폴더에서 보기</button></div>
              <div className="muted">교수 승인으로 표시되지 않습니다. 아직 통과하지 않은 검사 {unverified.length}건:</div>
              <ul>{unverified.slice(0, 12).map((r, i) => <li key={i}><code>{r.check_id}</code> {r.target}: {r.reason}</li>)}{unverified.length > 12 && <li>… 외 {unverified.length - 12}건</li>}</ul>
            </div>
          )}
        </div>
      )}

      {tab === 'paper' && (
        <div className="card">
          <p>겉표지~감사의 글과 Ⅰ~Ⅵ 골격 Markdown을 만듭니다. 미제공 값은 <code>[확인 필요]</code>로 남습니다. 입력 JSON은 에이전트가 만든 파일을 지정하세요(폴더 안 상대경로).</p>
          <div className="field"><span>입력 JSON</span><input value={form.paper_in} onChange={set('paper_in')} /><span /></div>
          <div className="field"><span>출력 경로</span><input value={form.paper_out} onChange={set('paper_out')} /><button onClick={() => setForm({ ...form, paper_out: versioned(form.paper_out, (p) => existing.has(p)) })}>새 버전 경로</button></div>
          <button className="primary" disabled={runner.busy} onClick={() => runner.run('paper.generate', { root, input: form.paper_in, out: form.paper_out })}>생성</button>
        </div>
      )}

      {tab === 'docx' && (
        <div className="card">
          <p>통합 본문 Markdown을 DOCX로 변환합니다. 표 하나 때문에 본문이 가로로 회전하지 않으며, 목차 뒤에 렌더되지 않는 내용이 있으면 실패로 알려줍니다.</p>
          <div className="field"><span>입력 Markdown</span><input value={form.docx_in} onChange={set('docx_in')} /><span /></div>
          <div className="field"><span>출력 DOCX</span><input value={form.docx_out} onChange={set('docx_out')} /><button onClick={() => setForm({ ...form, docx_out: versioned(form.docx_out, (p) => existing.has(p)) })}>새 버전 경로</button></div>
          <div className="field"><span>글꼴</span><input value={form.font} onChange={set('font')} /><span /></div>
          <button className="primary" disabled={runner.busy} onClick={() => runner.run('docx.build', { root, in: form.docx_in, out: form.docx_out, font: form.font })}>DOCX 만들기</button>
          <p className="muted">글꼴 신명조 확인, 여백, 페이지 번호는 한글에서 사람이 마무리합니다.</p>
        </div>
      )}

      {tab === 'excel' && (
        <div className="card">
          <p>학교 제출 양식(다른 작성자의 예시 XLSX)을 복제해 입력 셀만 비우고, 확인된 값을 채웁니다. 원본 형식·수식·병합은 보존됩니다.</p>
          <h3>1. 원본 검사(inspect)</h3>
          <div className="field"><span>원본 XLSX</span><input value={form.xl_source} onChange={set('xl_source')} placeholder="폴더 안 상대경로 또는 선택" /><button onClick={pick('xl_source', [{ name: 'Excel', extensions: ['xlsx'] }])}>선택…</button></div>
          <div className="field"><span>맵 출력</span><input value={form.xl_map} onChange={set('xl_map')} /><span /></div>
          <button disabled={runner.busy || !form.xl_source} onClick={() => runner.run('excel.inspect', { root, source: form.xl_source, out_map: form.xl_map, report: form.xl_map.replace(/\.json$/, '-report.json') })}>검사</button>
          <h3>2. 빈 사본 만들기(clear)</h3>
          <div className="field"><span>빈 사본 출력</span><input value={form.xl_blank} onChange={set('xl_blank')} /><button onClick={() => setForm({ ...form, xl_blank: versioned(form.xl_blank, (p) => existing.has(p)) })}>새 버전 경로</button></div>
          <button disabled={runner.busy || !form.xl_source} onClick={() => runner.run('excel.clear', { root, source: form.xl_source, map: form.xl_map, out: form.xl_blank, receipt: form.xl_blank.replace(/\.xlsx$/, '-receipt.json') })}>빈 사본 생성</button>
          <h3>3. 값 채우기(fill)</h3>
          <div className="field"><span>쓰기 맵 JSON</span><input value={form.xl_writemap} onChange={set('xl_writemap')} placeholder="에이전트가 만든 gg-xlsx-fill-map" /><span /></div>
          <div className="field"><span>값 JSON</span><input value={form.xl_values} onChange={set('xl_values')} placeholder="gg-xlsx-fill-values" /><span /></div>
          <div className="field"><span>채운 사본 출력</span><input value={form.xl_filled} onChange={set('xl_filled')} /><button onClick={() => setForm({ ...form, xl_filled: versioned(form.xl_filled, (p) => existing.has(p)) })}>새 버전 경로</button></div>
          <button disabled={runner.busy || !form.xl_writemap || !form.xl_values} onClick={() => runner.run('excel.fill', { root, template: form.xl_blank, map: form.xl_writemap, values: form.xl_values, out: form.xl_filled, receipt: form.xl_filled.replace(/\.xlsx$/, '-receipt.json') })}>값 채우기</button>
          <p className="muted">채운 뒤에는 실제 Excel 재계산(Office 렌더 탭)과 본문 대조가 필요합니다. 빈 사본만으로 재무 완료가 아닙니다.</p>
          <h3>4. 계보 확인(verify-template-lineage)</h3>
          <div className="field"><span>최종 XLSX</span><input value={form.xl_final} onChange={set('xl_final')} placeholder="Office 렌더로 재계산된 사본" /><button onClick={pick('xl_final', [{ name: 'Excel', extensions: ['xlsx'] }])}>선택…</button></div>
          <div className="field"><span>영수증 목록</span><input value={form.xl_receipts} onChange={set('xl_receipts')} placeholder="clear-receipt.json fill-receipt.json native/final.office.manifest.json (공백 구분)" /><span /></div>
          <button disabled={runner.busy || !form.xl_final || !form.xl_receipts} onClick={() => runner.run('office.verify_lineage', { root, input: form.xl_final, receipts: form.xl_receipts.split(/\s+/).filter(Boolean) })}>계보 확인</button>
        </div>
      )}

      {tab === 'office' && (
        <div className="card">
          <p>실제 Word/Excel을 열어 목차 갱신·재계산·PDF 출력을 합니다(macOS AppleScript / Windows COM). 처음 실행 시 운영체제의 자동화 권한 창이 뜨면 직접 허용해 주세요.</p>
          <div className="field"><span>입력 파일</span><input value={form.of_input} onChange={set('of_input')} /><button onClick={pick('of_input', [{ name: 'Office', extensions: ['docx', 'xlsx'] }])}>선택…</button></div>
          <div className="field"><span>출력 폴더(새 폴더)</span><input value={form.of_out} onChange={set('of_out')} /><button onClick={() => setForm({ ...form, of_out: versioned(form.of_out, (p) => existing.has(p)) })}>새 버전 경로</button></div>
          <div className="row">
            <button disabled={runner.busy} onClick={() => runner.run('office.doctor', { root })}>환경 진단</button>
            <button className="primary" disabled={runner.busy || !form.of_input} onClick={() => runner.run(form.of_input.toLowerCase().endsWith('.xlsx') ? 'office.excel' : 'office.word', { root, input: form.of_input, out_dir: form.of_out })}>변환 실행</button>
          </div>
        </div>
      )}

      {tab === 'tree' && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}><strong>{tree?.path}</strong><button onClick={loadTree}>새로고침</button></div>
          {tree?.revisions?.length === 0 && tree?.files?.length === 0 && <p className="muted">아직 발행물이 없습니다.</p>}
          {tree?.revisions?.map((r: any) => (
            <div key={r.revision}>
              <h3>개정 {r.revision}</h3>
              {r.kinds.map((k: any) => (
                <div key={k.kind} className="item">
                  <div className="head"><span><strong>{k.kind}</strong> {k.complete === true ? <span className="pill pass">완료</span> : k.complete === false ? <span className="pill fail">불완전</span> : null}</span><button onClick={() => window.knuaf.reveal(k.path)}>폴더에서 보기</button></div>
                  <div className="muted" style={{ fontSize: 12 }}>{k.files.map((f: any) => f.name).join(' · ')}</div>
                </div>
              ))}
            </div>
          ))}
          {tree?.files?.length > 0 && <div className="item"><strong>기타</strong><div className="muted" style={{ fontSize: 12 }}>{tree.files.map((f: any) => f.name).join(' · ')}</div></div>}
        </div>
      )}

      {runner.err && <div className="banner bad" style={{ marginTop: 12 }}>{runner.err}</div>}
      {runner.env && <div style={{ marginTop: 12 }}><EnvelopeView env={runner.env} onReveal={(p) => window.knuaf.reveal(p.startsWith('/') || /^[A-Za-z]:/.test(p) ? p : `${root}/${p}`)} /></div>}
      <RunLog lines={runner.lines} title={runner.busy ? '실행 중…' : undefined} />
    </div>
  )
}
