// Render docs/학생용-사용안내.md to docs/학생용-사용안내.pdf (A4) and docs/학생용-사용안내.html with
// Playwright's Chromium. Zero deps beyond playwright (already a devDependency).
// Run from app/: `node scripts/build-guide.mjs` (or `pnpm build:guide`).
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join, basename, extname } from 'node:path'
import { homedir } from 'node:os'
import { chromium } from 'playwright'

const app = resolve(import.meta.dirname, '..')
const docs = resolve(app, '..', 'docs')
const SRC = resolve(docs, '학생용-사용안내.md')
const PDF = resolve(docs, '학생용-사용안내.pdf')
const HTML = resolve(docs, '학생용-사용안내.html')
const FOOTER_TEXT = '한농대 창업논문 헬퍼 사용 안내'

// ---------------------------------------------------------------------------------------------
// Chromium launch (same strategy as build-icons.mjs)
// ---------------------------------------------------------------------------------------------

// Playwright's cache dir (mirrors its own default resolution; PLAYWRIGHT_BROWSERS_PATH overrides).
function playwrightCache() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH
  const home = homedir()
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright')
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright')
  return join(process.env.XDG_CACHE_HOME ?? join(home, '.cache'), 'ms-playwright')
}

// Any previously downloaded Playwright Chromium (headless shell preferred), newest build first.
function cachedChromiums() {
  const dir = playwrightCache()
  if (!existsSync(dir)) return []
  const rel =
    process.platform === 'darwin'
      ? { shell: 'chrome-headless-shell-mac-arm64/chrome-headless-shell', full: 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium' }
      : process.platform === 'win32'
        ? { shell: 'chrome-headless-shell-win64/chrome-headless-shell.exe', full: 'chrome-win/chrome.exe' }
        : { shell: 'chrome-headless-shell-linux/chrome-headless-shell', full: 'chrome-linux/chrome' }
  const found = []
  for (const name of readdirSync(dir)) {
    const m = /^(chromium_headless_shell|chromium)-(\d+)$/.exec(name)
    if (!m) continue
    const exe = join(dir, name, m[1] === 'chromium' ? rel.full : rel.shell)
    if (existsSync(exe)) found.push({ build: Number(m[2]), shell: m[1] !== 'chromium', exe })
  }
  return found.sort((a, b) => b.build - a.build || Number(b.shell) - Number(a.shell)).map((f) => f.exe)
}

// Prefer the Chromium build bundled with this playwright version; fall back to any cached build,
// then to a system Chrome — so the script never needs a fresh `playwright install`.
async function launchChromium() {
  const attempts = [
    { label: 'bundled chromium', opts: {} },
    ...cachedChromiums().map((exe) => ({ label: exe, opts: { executablePath: exe } })),
    { label: 'system chrome', opts: { channel: 'chrome' } },
  ]
  const errors = []
  for (const { label, opts } of attempts) {
    try {
      const browser = await chromium.launch(opts)
      if (Object.keys(opts).length) console.log('using', label)
      return browser
    } catch (e) {
      errors.push(`${label}: ${String(e.message).split('\n')[0]}`)
    }
  }
  throw new Error('no Chromium available for Playwright:\n  ' + errors.join('\n  '))
}

// ---------------------------------------------------------------------------------------------
// Minimal Markdown → HTML
// Supports: # / ## / ### headings, paragraphs, - bullet and 1. numbered lists, | tables |,
// **bold**, `code`, [text](url), bare https:// links, ![alt](images/x.png), ``` fenced code,
// and raw <svg …>…</svg> blocks (passed through untouched).
// ---------------------------------------------------------------------------------------------

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// `imageSrc(relPath)` decides how image paths are emitted (absolute file:// for the PDF render,
// relative for the HTML that lives next to the markdown).
function inline(text, imageSrc) {
  // Tokenize code spans first so nothing inside them is touched.
  const codes = []
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = escapeHtml(s)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img src="${imageSrc(src)}" alt="${alt}">`)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}<a href="${u}">${u}</a>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)])
  return s
}

function markdownToHtml(md, imageSrc) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  const isBlank = (l) => l === undefined || l.trim() === ''

  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      i++
      continue
    }

    // Raw SVG block: from a line starting with <svg to the line containing </svg>.
    if (/^\s*<svg[\s>]/.test(line)) {
      const buf = []
      while (i < lines.length) {
        buf.push(lines[i])
        if (/<\/svg>/.test(lines[i])) {
          i++
          break
        }
        i++
      }
      out.push(`<figure class="diagram">${buf.join('\n')}</figure>`)
      continue
    }

    // Fenced code block.
    if (/^```/.test(line)) {
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++ // closing fence
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`)
      continue
    }

    // Headings.
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      out.push(`<h${level}>${inline(h[2].trim(), imageSrc)}</h${level}>`)
      i++
      continue
    }

    // Table: header row, separator row, body rows.
    if (/^\|.*\|\s*$/.test(line) && /^\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const cells = (l) =>
        l
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push(
        '<table><thead><tr>' +
          head.map((c) => `<th>${inline(c, imageSrc)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c, imageSrc)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>',
      )
      continue
    }

    // Lists (bullet or numbered); a list ends at a blank line or a non-list line.
    const bullet = /^\s*[-*]\s+/
    const number = /^\s*\d+\.\s+/
    if (bullet.test(line) || number.test(line)) {
      const ordered = number.test(line)
      const re = ordered ? number : bullet
      const items = []
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i].replace(re, '')
        i++
        // Lazy continuation lines (indented, non-list, non-blank).
        while (i < lines.length && !isBlank(lines[i]) && !re.test(lines[i]) && /^\s+/.test(lines[i])) {
          item += ' ' + lines[i].trim()
          i++
        }
        items.push(`<li>${inline(item, imageSrc)}</li>`)
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }

    // Standalone image line → figure.
    const img = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line)
    if (img) {
      out.push(`<figure><img src="${imageSrc(img[2])}" alt="${escapeHtml(img[1])}"></figure>`)
      i++
      continue
    }

    // Paragraph: consecutive non-blank lines; soft line breaks are kept as <br>.
    const buf = []
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !/^(#{1,3})\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*<svg[\s>]/.test(lines[i]) &&
      !bullet.test(lines[i]) &&
      !number.test(lines[i]) &&
      !/^\|.*\|\s*$/.test(lines[i]) &&
      !/^!\[[^\]]*\]\([^)]+\)\s*$/.test(lines[i])
    ) {
      buf.push(lines[i].trim())
      i++
    }
    if (buf.length) out.push(`<p>${buf.map((l) => inline(l, imageSrc)).join('<br>')}</p>`)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

const CSS = `
@page { size: A4; margin: 18mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  font-family: -apple-system, "Apple SD Gothic Neo", "Pretendard", sans-serif;
  font-size: 11pt; line-height: 1.6; color: #1d1d1f; background: #fff;
  margin: 0; word-break: keep-all; overflow-wrap: break-word;
}
main { max-width: 174mm; margin: 0 auto; }
h1 { font-size: 20pt; line-height: 1.3; margin: 0 0 6pt; letter-spacing: -0.01em; }
h1 + p { color: #555; margin-top: 0; }
h2 { font-size: 14pt; line-height: 1.35; margin: 22pt 0 8pt; padding-bottom: 4pt; border-bottom: 0.5pt solid #bbb; break-after: avoid; page-break-after: avoid; }
h3 { font-size: 12pt; margin: 14pt 0 6pt; break-after: avoid; page-break-after: avoid; }
p { margin: 0 0 8pt; }
ul, ol { margin: 0 0 8pt; padding-left: 1.4em; }
li { margin: 2pt 0; }
li::marker { color: #2f6b3a; }
strong { font-weight: 600; }
code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.92em; background: #f2f2f2; border-radius: 3px; padding: 0.05em 0.35em; }
pre { background: #f5f5f5; border: 0.5pt solid #ddd; border-radius: 6px; padding: 8pt 10pt; font-size: 9.5pt; line-height: 1.5; overflow: hidden; white-space: pre-wrap; break-inside: avoid; page-break-inside: avoid; }
pre code { background: none; padding: 0; font-size: inherit; }
a { color: #2f6b3a; text-decoration: none; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 12pt; font-size: 10.5pt; break-inside: avoid; page-break-inside: avoid; }
th, td { border: 0.5pt solid #b5b5b5; padding: 4pt 7pt; text-align: left; vertical-align: top; }
th { background: #f3f5f3; font-weight: 600; white-space: nowrap; }
tr { break-inside: avoid; page-break-inside: avoid; }
figure { margin: 8pt 0 12pt; break-inside: avoid; page-break-inside: avoid; }
figure img { max-width: 150mm; margin: 0 auto; }
img { max-width: 100%; height: auto; display: block; border: 1px solid #c8c8c8; border-radius: 6px; break-inside: avoid; page-break-inside: avoid; }
figure.diagram { text-align: center; }
figure.diagram svg { max-width: 100%; height: auto; border: 0; }
`

function pageHtml(body) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${FOOTER_TEXT}</title>
<style>${CSS}</style>
</head>
<body><main>
${body}
</main></body>
</html>
`
}

const FOOTER_TEMPLATE = `
<div style="width:100%;font-family:-apple-system,'Apple SD Gothic Neo',Pretendard,sans-serif;font-size:8pt;color:#777;text-align:center;padding:0 18mm;">
  ${FOOTER_TEXT} · <span class="pageNumber"></span>/<span class="totalPages"></span>
</div>`

// ---------------------------------------------------------------------------------------------

const md = readFileSync(SRC, 'utf8')

// HTML for the in-app Help menu: keep image paths relative (it lives next to the markdown).
const htmlRelative = pageHtml(markdownToHtml(md, (p) => p))
writeFileSync(HTML, htmlRelative)
console.log('wrote', HTML)

// PDF render: `setContent` pages are about:blank and may not load file:// images, so embed each
// screenshot (resolved from docs/) as a data: URI instead.
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' }
function embedImage(p) {
  if (/^[a-z]+:/i.test(p)) return p
  const abs = resolve(docs, p)
  if (!existsSync(abs)) throw new Error(`image not found: ${abs} (referenced as ${p})`)
  const mime = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream'
  return `data:${mime};base64,${readFileSync(abs).toString('base64')}`
}
const htmlAbsolute = pageHtml(markdownToHtml(md, embedImage))

const browser = await launchChromium()
try {
  const page = await browser.newPage()
  await page.setContent(htmlAbsolute, { waitUntil: 'load' })
  // Fail loudly if a screenshot is missing rather than shipping a PDF with broken images.
  const missing = await page.$$eval('img', (imgs) => imgs.filter((im) => !im.complete || im.naturalWidth === 0).map((im) => im.getAttribute('src')))
  if (missing.length) throw new Error('images failed to load:\n  ' + missing.join('\n  '))
  await page.pdf({
    path: PDF,
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', right: '18mm', bottom: '18mm', left: '18mm' },
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: FOOTER_TEMPLATE,
  })
  console.log('wrote', PDF, `(${basename(SRC)} → pdf)`)
} finally {
  await browser.close()
}
