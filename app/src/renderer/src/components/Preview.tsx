import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
// The legacy build is required: pdfjs 6.x uses Uint8Array.toHex, missing in Electron 37's Chromium.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { ArtifactItem, ArtifactPreview } from '../../../shared/types'
import { rpc } from '../rpc'
import { describeError, type DescribedError } from '../copy'
import { useRunner } from './useRunner'
import { Feedback } from './Feedback'
import { Badge } from './Badge'
import { SegmentedControl } from './SegmentedControl'
import { ProgressPanel } from './ProgressPanel'
import { ARTIFACTS, COMPLETION, PREVIEW, officeHint } from '../copy'
import { versioned } from '../screens/Outputs'

// pdf.js renders PDFs in-process; the worker file ships in the renderer bundle as an asset.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString()

type PreviewError = DescribedError | null

/** Load `<root>/<path>` bytes via file:read and render pages onto a canvas with page nav. */
function PdfView({ root, path }: { root: string; path: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [err, setErr] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let dead = false
    let task: pdfjs.PDFDocumentLoadingTask | null = null
    setDoc(null); setErr(null); setPage(1)
    void (async () => {
      const r = await window.knuaf.fileRead(root, path)
      if (dead) return
      if (r.error || !r.result) { setErr(describeError(r.error ?? PREVIEW.loadFailed).raw); return }
      try {
        const bytes = r.result instanceof Uint8Array ? r.result : new Uint8Array(r.result as ArrayBuffer)
        task = pdfjs.getDocument({ data: bytes })
        const loaded = await task.promise
        if (dead) { void task.destroy(); return }
        setDoc(loaded)
      } catch (e) { if (!dead) setErr(String(e instanceof Error ? e.message : e)) }
    })()
    return () => { dead = true; void task?.destroy() }
  }, [root, path])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!doc || !canvas) return
    let dead = false
    let task: { promise: Promise<unknown>; cancel: () => void } | null = null
    void (async () => {
      try {
        const p = await doc.getPage(page)
        if (dead) return
        const dpr = window.devicePixelRatio || 1
        const viewport = p.getViewport({ scale: 1.5 * dpr })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`
        task = p.render({ canvas, viewport })
        await task.promise
      } catch (e) { if (!dead) setErr(String(e instanceof Error ? e.message : e)) }
    })()
    return () => { dead = true; task?.cancel() }
  }, [doc, page])

  if (err) return <Feedback kind="error" title={PREVIEW.loadFailed} body={<code>{err}</code>} />
  if (!doc) return <p className="caption">PDF를 여는 중…</p>
  return (
    <div>
      <div className="row" style={{ marginBottom: 'var(--sp-2)' }}>
        <button onClick={() => setPage((n) => Math.max(1, n - 1))} disabled={page <= 1} aria-label="이전 페이지">{PREVIEW.prev}</button>
        <span className="caption" aria-live="polite">{PREVIEW.pageOf(page, doc.numPages)}</span>
        <button onClick={() => setPage((n) => Math.min(doc.numPages, n + 1))} disabled={page >= doc.numPages} aria-label="다음 페이지">{PREVIEW.next}</button>
      </div>
      <div className="preview-canvas"><canvas ref={canvasRef} /></div>
    </div>
  )
}

/** Same-stem PDF staged next to the DOCX or under build/native — the only DOCX preview we trust. */
function stagedPdf(item: ArtifactItem, items: ArtifactItem[]): ArtifactItem | null {
  const stem = item.name.replace(/\.[^.]+$/, '')
  const dir = item.path.slice(0, item.path.length - item.name.length)
  return items.find((i) => i.kind === 'pdf' && i.name === `${stem}.pdf` && (i.path.startsWith(dir) || i.path.startsWith('build/native/'))) ?? null
}

function DocxView({ root, item, items, onRendered }: { root: string; item: ArtifactItem; items: ArtifactItem[]; onRendered: () => void }) {
  const runner = useRunner()
  const pdf = useMemo(() => stagedPdf(item, items), [item, items])
  const absPath = useMemo(() => (item.path.startsWith('/') || /^[A-Za-z]:/.test(item.path) ? item.path : `${root}/${item.path}`), [root, item.path])
  // office.word needs a brand-new output dir; versioned() picks build/native, -v2, … automatically.
  const outDir = useMemo(() => versioned('build/native', (p) => items.some((i) => i.path === p || i.path.startsWith(p + '/'))), [items])
  if (pdf) {
    return (
      <div>
        <p className="caption">{PREVIEW.docxPdfCaption} <code>{pdf.path}</code></p>
        <PdfView root={root} path={pdf.path} />
      </div>
    )
  }
  const doRender = async () => {
    const env = await runner.run('office.word', { root, input: item.path, out_dir: outDir })
    if (env?.ok) onRendered()
  }
  const hint = officeHint(runner.env?.block_reason ?? (runner.env?.data as { engine_stderr?: string } | null)?.engine_stderr)
  return (
    <div>
      <Feedback
        kind="status"
        title={PREVIEW.docxNoPdfTitle}
        body={PREVIEW.docxNoPdfBody}
        actions={
          <>
            <button className="primary" disabled={runner.busy} onClick={doRender}>{runner.busy ? PREVIEW.docxRendering : PREVIEW.docxRender}</button>
            <button onClick={() => window.knuaf.openPath(absPath)}>{ARTIFACTS.openExternal}</button>
          </>
        }
      />
      {runner.err && <div style={{ marginTop: 'var(--sp-3)' }}><Feedback kind="error" title={PREVIEW.loadFailed} body={<code>{runner.err}</code>} /></div>}
      {runner.env && !runner.busy && !runner.env.ok && (
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <Feedback kind="warning" title={hint?.title ?? 'PDF를 만들지 못했어요'} body={hint?.body ?? runner.env.block_reason ?? 'Word가 없거나 실행을 완료하지 못했어요. "원래 앱으로 열기"로 직접 확인해 주세요.'} />
        </div>
      )}
      <ProgressPanel busy={runner.busy} phase={runner.phase} elapsedMs={runner.elapsedMs} lines={runner.lines} onCancel={runner.cancel} />
      {runner.env?.ok && <div style={{ marginTop: 'var(--sp-3)' }}><Feedback kind="completion" title={COMPLETION.docx_built} /></div>}
    </div>
  )
}

function XlsxView({ root, item }: { root: string; item: ArtifactItem }) {
  const [data, setData] = useState<Extract<ArtifactPreview, { kind: 'xlsx' }> | null>(null)
  const [err, setErr] = useState<PreviewError>(null)
  const [unavail, setUnavail] = useState<string | null>(null)
  const [sheet, setSheet] = useState(0)
  useEffect(() => {
    let dead = false
    setData(null); setErr(null); setUnavail(null); setSheet(0)
    void (async () => {
      try {
        const r = await rpc.artifactPreview(root, item.path)
        if (dead) return
        if (r.kind === 'xlsx') setData(r)
        else if (r.kind === 'unavailable') setUnavail(r.reason)
        else setUnavail(PREVIEW.unavailable)
      } catch (e) { if (!dead) setErr(describeError(e)) }
    })()
    return () => { dead = true }
  }, [root, item.path])
  if (err) return <Feedback kind={err.kind} title={err.title} body={err.action} details={<code>{err.raw}</code>} />
  if (unavail) return <Feedback kind="status" title={PREVIEW.unavailable} body={unavail} />
  if (!data) return <p className="caption">표를 여는 중…</p>
  const s = data.sheets[sheet] ?? data.sheets[0]
  return (
    <div>
      {data.formulas_uncalculated && <div style={{ marginBottom: 'var(--sp-3)' }}><Feedback kind="warning" title={PREVIEW.uncalculatedTitle} body={PREVIEW.uncalculatedBody} /></div>}
      <div className="row" style={{ marginBottom: 'var(--sp-2)' }}>
        {data.sheets.length > 1 && (
          <SegmentedControl
            value={String(sheet)}
            options={data.sheets.map((sh, i) => ({ id: String(i), label: sh.name }))}
            onChange={(v) => setSheet(Number(v))}
            label="시트"
          />
        )}
        {s?.truncated && <Badge label={PREVIEW.truncated} />}
      </div>
      {s && (
        <div className="preview-table-wrap">
          <table className="preview-table">
            <tbody>
              {s.rows.map((row, ri) => (
                <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {s.rows.length === 0 && <p className="caption">{PREVIEW.empty}</p>}
        </div>
      )}
    </div>
  )
}

function TextView({ root, item }: { root: string; item: ArtifactItem }) {
  const [data, setData] = useState<{ text: string; truncated: boolean } | null>(null)
  const [err, setErr] = useState<PreviewError>(null)
  useEffect(() => {
    let dead = false
    setData(null); setErr(null)
    void (async () => {
      try {
        const r = await rpc.artifactPreview(root, item.path)
        if (!dead && r.kind === 'text') setData(r)
        else if (!dead && r.kind === 'unavailable') setErr(describeError({ code: 'internal', message: r.reason }))
      } catch (e) { if (!dead) setErr(describeError(e)) }
    })()
    return () => { dead = true }
  }, [root, item.path])
  if (err) return <Feedback kind={err.kind} title={err.title} body={err.action} details={<code>{err.raw}</code>} />
  if (!data) return <p className="caption">불러오는 중…</p>
  return (
    <div>
      {data.truncated && <div style={{ marginBottom: 'var(--sp-2)' }}><Badge label={PREVIEW.truncated} /></div>}
      <div className="prose">{data.text || PREVIEW.empty}</div>
    </div>
  )
}

/** Preview for one artifact list item. `onRendered` asks the parent to reload after Office render. */
export function Preview({ root, item, items, onRendered }: { root: string; item: ArtifactItem; items: ArtifactItem[]; onRendered: () => void }) {
  let body: ReactNode
  if (item.kind === 'pdf') body = <PdfView root={root} path={item.path} />
  else if (item.kind === 'docx') body = <DocxView root={root} item={item} items={items} onRendered={onRendered} />
  else if (item.kind === 'xlsx') body = <XlsxView root={root} item={item} />
  else if (item.kind === 'md') body = <TextView root={root} item={item} />
  else body = <Feedback kind="status" title={PREVIEW.unavailable} />
  return <div className="preview">{body}</div>
}
