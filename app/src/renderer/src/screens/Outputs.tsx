import { useEffect, useMemo, useState } from 'react'
import { useProject } from '../store/project'
import { rpc } from '../rpc'
import { Toolbar } from '../components/Toolbar'
import { SegmentedControl } from '../components/SegmentedControl'
import { Feedback } from '../components/Feedback'
import { Field, validateOutPath } from '../components/Field'
import { Disclosure } from '../components/Disclosure'
import { Badge, StatusBadge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { ProgressPanel } from '../components/ProgressPanel'
import { ResultCard } from '../components/ResultCard'
import { useRunner } from '../components/useRunner'
import { COMPLETION, EMPTY, FIELD_HINT, FIELD_LABEL, NOT_APPROVAL_NOTE, NO_OVERWRITE_NOTE, SCREEN_INTRO, describeError, officeHint, type DescribedError } from '../copy'

type Tab = 'export' | 'paper' | 'docx' | 'excel' | 'office' | 'tree'
const TABS: { id: Tab; label: string }[] = [{ id: 'export', label: '검토본' }, { id: 'paper', label: '논문 골격' }, { id: 'docx', label: 'DOCX' }, { id: 'excel', label: '재무 엑셀' }, { id: 'office', label: 'Office 렌더' }, { id: 'tree', label: 'build 폴더' }]

/** Next free sibling name (…-v2, -v3): outputs are never overwritten. */
export function versioned(path: string, taken: (p: string) => boolean): string {
  if (!taken(path)) return path
  const m = path.match(/^(.*?)(?:-v(\d+))?(\.[^./\\]+)?$/)
  const base = m?.[1] ?? path, ext = m?.[3] ?? ''
  for (let i = 2; i < 100; i++) { const c = `${base}-v${i}${ext}`; if (!taken(c)) return c }
  return path
}
const isAbs = (p: string) => p.startsWith('/') || /^[A-Za-z]:/.test(p)

export function Outputs() {
  const { root, status, refresh } = useProject()
  const platform = window.knuaf.platform
  const joinPath = (a: string, b: string) => isAbs(b) ? b : `${a}${platform === 'win32' ? '\\' : '/'}${b}`
  const [tab, setTab] = useState<Tab>('export')
  const [tree, setTree] = useState<any>(null)
  const runner = useRunner()
  const [kind, setKind] = useState('review')
  const [exportResult, setExportResult] = useState<{ path: string } | null>(null)
  const [exportErr, setExportErr] = useState<DescribedError | null>(null)
  const [form, setForm] = useState<Record<string, string>>({ paper_in: 'paper-input.json', paper_out: 'build/검토전_본문.md', docx_in: 'build/본문_통합.md', docx_out: 'build/검토전_논문.docx', font: '신명조', xl_source: '', xl_map: 'build/template-review/source-map.json', xl_blank: 'build/template-review/blank-v1.xlsx', xl_values: '', xl_writemap: '', xl_filled: 'build/template-review/filled-v1.xlsx', xl_final: '', xl_receipts: '', of_input: '', of_out: 'build/native' })
  const existing = useMemo(() => {
    const s = new Set<string>()
    tree?.revisions?.forEach((r: any) => r.kinds.forEach((k: any) => k.files.forEach((f: any) => s.add(`build/${r.revision}/${k.kind}/${f.name}`))))
    tree?.files?.forEach((f: any) => s.add('build/' + f.name))
    return s
  }, [tree])
  const loadTree = async () => { if (root) setTree(await rpc.buildTree(root)) }
  useEffect(() => { void loadTree() }, [root, runner.env, exportResult])
  useEffect(() => {
    // pre-version the default names so the common path never collides
    setForm((f) => ({ ...f, paper_out: versioned(f.paper_out, (p) => existing.has(p)), docx_out: versioned(f.docx_out, (p) => existing.has(p)) }))
  }, [existing])
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  const pick = (k: string, filters: { name: string; extensions: string[] }[]) => async () => { const f = await window.knuaf.pickFile({ filters, defaultPath: root ?? undefined }); if (f) setForm({ ...form, [k]: f }) }
  const rename = (k: string) => () => setForm({ ...form, [k]: versioned(form[k], (p) => existing.has(p)) })
  const doExport = async () => {
    if (!root) return
    setExportErr(null); setExportResult(null)
    try { setExportResult(await rpc.export(root, kind)); await refresh() } catch (e) { setExportErr(describeError(e)) }
  }
  if (!root) return null
  const unverified = status ? status.gate.filter((r) => r.status !== 'pass' && r.severity === 'error') : []
  const reveal = (p: string) => window.knuaf.reveal(joinPath(root, p))
  const vOut = (k: string, ext: string[]) => validateOutPath(form[k], ext, (p) => existing.has(p))
  const done = (m: string) => runner.env?.ok && runner.env.argv.some((a) => a.endsWith(m))

  return (
    <div>
      <Toolbar title="산출물" sub={<SegmentedControl value={tab} options={TABS} onChange={setTab} label="산출물 종류" />} />
      <p className="intro">{SCREEN_INTRO.outputs}</p>

      {tab === 'export' && (
        <div className="card">
          <div className="card-head"><h2>검토본 내보내기</h2>{status && <Badge label={`개정 ${status.revision}`} />}</div>
          <p>지금 정본의 본문을 <code>build/{status?.revision}/{kind}/</code>에 발행해요. {NO_OVERWRITE_NOTE}</p>
          <div className="row">
            <select aria-label="종류" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="draft">검토전 초안</option><option value="review">검토용</option><option value="submission_candidate">검사완료·교수확인전</option>
            </select>
            <button className="primary" onClick={doExport}>발행하기</button>
          </div>
          {exportErr && <div style={{ marginTop: 'var(--sp-3)' }}><Feedback kind={exportErr.kind} title={exportErr.title} body={exportErr.action} details={<code>{exportErr.raw}</code>} /></div>}
          {exportResult && (
            <div style={{ marginTop: 'var(--sp-3)' }}>
              <Feedback kind="completion" title={COMPLETION.exported} body={<span><code>{exportResult.path}</code><br /><span className="caption">{NOT_APPROVAL_NOTE}</span></span>} actions={<button onClick={() => window.knuaf.reveal(exportResult.path)}>폴더에서 보기</button>}
                details={<div><div className="caption">아직 통과하지 않은 검사 {unverified.length}건</div><ul>{unverified.slice(0, 12).map((r, i) => <li key={i}><code>{r.check_id}</code> {r.target}: {r.reason}</li>)}{unverified.length > 12 && <li>… 외 {unverified.length - 12}건</li>}</ul></div>} />
            </div>
          )}
        </div>
      )}

      {tab === 'paper' && (
        <div className="card">
          <div className="card-head"><h2>논문 골격 만들기</h2></div>
          <p>겉표지부터 감사의 글, Ⅰ~Ⅵ 골격을 만들어요. 아직 모르는 값은 <code>[확인 필요]</code>로 남아요.</p>
          <Field id="paper_in" label={FIELD_LABEL.paper_input} help={FIELD_HINT.paper_input}><input id="paper_in" value={form.paper_in} onChange={set('paper_in')} /></Field>
          <Disclosure label="고급"><Field id="paper_out" label={FIELD_LABEL.out_path} invalid={vOut('paper_out', ['.md'])} trailing={<button onClick={rename('paper_out')}>다른 이름으로</button>}><input id="paper_out" value={form.paper_out} onChange={set('paper_out')} aria-invalid={!!vOut('paper_out', ['.md'])} /></Field></Disclosure>
          <div className="row" style={{ marginTop: 'var(--sp-3)' }}><button className="primary" disabled={runner.busy || !!vOut('paper_out', ['.md']) || !form.paper_in} onClick={() => runner.run('paper.generate', { root, input: form.paper_in, out: form.paper_out })}>골격 만들기</button></div>
        </div>
      )}

      {tab === 'docx' && (
        <div className="card">
          <div className="card-head"><h2>DOCX 만들기</h2></div>
          <p>통합 본문을 DOCX로 바꿔요. 표 하나 때문에 본문이 가로로 돌아가지 않고, 목차 뒤에 빠지는 내용이 있으면 실패로 알려 줘요.</p>
          <Field id="docx_in" label={FIELD_LABEL.docx_in}><input id="docx_in" value={form.docx_in} onChange={set('docx_in')} /></Field>
          <Disclosure label="고급">
            <Field id="docx_out" label={FIELD_LABEL.out_path} invalid={vOut('docx_out', ['.docx'])} trailing={<button onClick={rename('docx_out')}>다른 이름으로</button>}><input id="docx_out" value={form.docx_out} onChange={set('docx_out')} aria-invalid={!!vOut('docx_out', ['.docx'])} /></Field>
            <Field id="font" label={FIELD_LABEL.font} help={FIELD_HINT.font}><input id="font" value={form.font} onChange={set('font')} /></Field>
          </Disclosure>
          <div className="row" style={{ marginTop: 'var(--sp-3)' }}><button className="primary" disabled={runner.busy || !!vOut('docx_out', ['.docx'])} onClick={() => runner.run('docx.build', { root, in: form.docx_in, out: form.docx_out, font: form.font })}>DOCX 만들기</button></div>
          <p className="caption" style={{ marginTop: 'var(--sp-3)' }}>글꼴 신명조 확인, 여백, 페이지 번호는 한글에서 사람이 마무리해요.</p>
        </div>
      )}

      {tab === 'excel' && (
        <div className="card">
          <div className="card-head"><h2>학교 양식으로 재무 엑셀 만들기</h2></div>
          <p>학교 양식 파일을 복제해 입력 칸만 비우고, 확인된 값을 채워요. 원본의 서식·수식·병합은 그대로 남아요.</p>
          <ol className="stack" style={{ paddingLeft: 0, listStyle: 'none' }}>
            <li className="item">
              <div className="head"><strong>1. 원본 검사</strong>{done('gg_excel_template.py') && runner.env?.argv.includes('inspect') && <StatusBadge status="pass" label="완료" />}</div>
              <Field id="xl_source" label={FIELD_LABEL.xl_source} trailing={<button onClick={pick('xl_source', [{ name: 'Excel', extensions: ['xlsx'] }])}>선택…</button>}><input id="xl_source" value={form.xl_source} onChange={set('xl_source')} placeholder="폴더 안 경로 또는 선택" /></Field>
              <Disclosure label="고급"><Field id="xl_map" label={FIELD_LABEL.xl_map} help={FIELD_HINT.xl_map}><input id="xl_map" value={form.xl_map} onChange={set('xl_map')} /></Field></Disclosure>
              <div style={{ marginTop: 'var(--sp-2)' }}><button className="primary" disabled={runner.busy || !form.xl_source} onClick={() => runner.run('excel.inspect', { root, source: form.xl_source, out_map: form.xl_map, report: form.xl_map.replace(/\.json$/, '-report.json') })}>검사</button></div>
            </li>
            <li className="item">
              <div className="head"><strong>2. 빈 사본 만들기</strong></div>
              <Field id="xl_blank" label={FIELD_LABEL.xl_blank} invalid={vOut('xl_blank', ['.xlsx'])} trailing={<button onClick={rename('xl_blank')}>다른 이름으로</button>}><input id="xl_blank" value={form.xl_blank} onChange={set('xl_blank')} aria-invalid={!!vOut('xl_blank', ['.xlsx'])} /></Field>
              <div style={{ marginTop: 'var(--sp-2)' }}><button className="primary" disabled={runner.busy || !form.xl_source || !!vOut('xl_blank', ['.xlsx'])} onClick={() => runner.run('excel.clear', { root, source: form.xl_source, map: form.xl_map, out: form.xl_blank, receipt: form.xl_blank.replace(/\.xlsx$/, '-receipt.json') })}>빈 사본 만들기</button></div>
            </li>
            <li className="item">
              <div className="head"><strong>3. 값 채우기</strong></div>
              <Field id="xl_writemap" label={FIELD_LABEL.xl_writemap} help={FIELD_HINT.xl_writemap}><input id="xl_writemap" value={form.xl_writemap} onChange={set('xl_writemap')} /></Field>
              <Field id="xl_values" label={FIELD_LABEL.xl_values} help={FIELD_HINT.xl_values}><input id="xl_values" value={form.xl_values} onChange={set('xl_values')} /></Field>
              <Field id="xl_filled" label={FIELD_LABEL.xl_filled} invalid={vOut('xl_filled', ['.xlsx'])} trailing={<button onClick={rename('xl_filled')}>다른 이름으로</button>}><input id="xl_filled" value={form.xl_filled} onChange={set('xl_filled')} aria-invalid={!!vOut('xl_filled', ['.xlsx'])} /></Field>
              <div style={{ marginTop: 'var(--sp-2)' }}><button className="primary" disabled={runner.busy || !form.xl_writemap || !form.xl_values || !!vOut('xl_filled', ['.xlsx'])} onClick={() => runner.run('excel.fill', { root, template: form.xl_blank, map: form.xl_writemap, values: form.xl_values, out: form.xl_filled, receipt: form.xl_filled.replace(/\.xlsx$/, '-receipt.json') })}>값 채우기</button></div>
              <p className="caption" style={{ marginTop: 'var(--sp-2)' }}>채운 뒤에는 실제 Excel 재계산(Office 렌더)과 본문 대조가 필요해요. 빈 사본만으로 재무 완료가 아니에요.</p>
            </li>
            <li className="item">
              <div className="head"><strong>4. 계보 확인</strong></div>
              <Field id="xl_final" label={FIELD_LABEL.xl_final} trailing={<button onClick={pick('xl_final', [{ name: 'Excel', extensions: ['xlsx'] }])}>선택…</button>}><input id="xl_final" value={form.xl_final} onChange={set('xl_final')} /></Field>
              <Field id="xl_receipts" label={FIELD_LABEL.xl_receipts} help={FIELD_HINT.xl_receipts}><input id="xl_receipts" value={form.xl_receipts} onChange={set('xl_receipts')} /></Field>
              <div style={{ marginTop: 'var(--sp-2)' }}><button disabled={runner.busy || !form.xl_final || !form.xl_receipts} onClick={() => runner.run('office.verify_lineage', { root, input: form.xl_final, receipts: form.xl_receipts.split(/\s+/).filter(Boolean) })}>계보 확인</button></div>
            </li>
          </ol>
        </div>
      )}

      {tab === 'office' && (
        <div className="card">
          <div className="card-head"><h2>Office 렌더</h2></div>
          <p>실제 Word/Excel을 열어 목차 갱신·재계산·PDF 출력을 해요. 처음 실행 때 운영체제의 자동화 권한 창이 뜨면 직접 허용해 주세요.</p>
          <Field id="of_input" label={FIELD_LABEL.of_input} trailing={<button onClick={pick('of_input', [{ name: 'Office', extensions: ['docx', 'xlsx'] }])}>선택…</button>}><input id="of_input" value={form.of_input} onChange={set('of_input')} /></Field>
          <Field id="of_out" label={FIELD_LABEL.of_out} invalid={vOut('of_out', [])} trailing={<button onClick={rename('of_out')}>다른 이름으로</button>}><input id="of_out" value={form.of_out} onChange={set('of_out')} /></Field>
          <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
            <button disabled={runner.busy} onClick={() => runner.run('office.doctor', { root })}>환경 진단</button>
            <button className="primary" disabled={runner.busy || !form.of_input || !!vOut('of_out', [])} onClick={() => runner.run(form.of_input.toLowerCase().endsWith('.xlsx') ? 'office.excel' : 'office.word', { root, input: form.of_input, out_dir: form.of_out })}>변환 실행</button>
          </div>
        </div>
      )}

      {tab === 'tree' && (
        <div className="card">
          <div className="card-head"><h2>build 폴더</h2><button onClick={loadTree}>새로고침</button></div>
          {tree && tree.revisions?.length === 0 && tree.files?.length === 0 && <EmptyState icon="box" title={EMPTY.build_tree.title} body={EMPTY.build_tree.body} />}
          {tree?.revisions?.map((r: any) => (
            <div key={r.revision}>
              <h3>개정 {r.revision}</h3>
              <div className="list">
                {r.kinds.map((k: any) => (
                  <div key={k.kind} className="item">
                    <div className="head"><span className="row"><strong>{k.kind}</strong>{k.complete === true ? <StatusBadge status="pass" label="완료" /> : k.complete === false ? <StatusBadge status="fail" label="불완전" /> : null}</span><button onClick={() => window.knuaf.reveal(k.path)}>폴더에서 보기</button></div>
                    <div className="caption">{k.files.map((f: any) => f.name).join(' · ')}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {tree?.files?.length > 0 && <div className="item" style={{ marginTop: 'var(--sp-3)' }}><strong>기타</strong><div className="caption">{tree.files.map((f: any) => f.name).join(' · ')}</div></div>}
        </div>
      )}

      {runner.err && <div style={{ marginTop: 'var(--sp-4)' }}>{(() => { const d = describeError({ code: null, message: runner.err }); return <Feedback kind="error" title={d.title} body={d.action} details={<code>{runner.err}</code>} /> })()}</div>}
      {runner.cancelled && <div style={{ marginTop: 'var(--sp-4)' }}><Feedback kind="status" title={COMPLETION.cancelled} /></div>}
      <ProgressPanel busy={runner.busy} phase={runner.phase} elapsedMs={runner.elapsedMs} lines={runner.lines} onCancel={runner.cancel} />
      {runner.env && !runner.busy && (() => { const h = officeHint(runner.env.block_reason ?? (runner.env.data as any)?.engine_stderr); return h ? <div style={{ marginTop: 'var(--sp-4)' }}><Feedback kind="warning" title={h.title} body={h.body} /></div> : null })()}
      {runner.env && !runner.busy && <ResultCard env={runner.env} onReveal={reveal} onOpen={(p) => window.knuaf.openPath(joinPath(root, p))} />}
    </div>
  )
}
