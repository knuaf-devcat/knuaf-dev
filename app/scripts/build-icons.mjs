// Render build/icon.svg (and icon-small.svg for <= 32px) to PNG with Playwright's Chromium,
// then assemble build/icon.iconset, build/icon.png, build/icon.icns (macOS only) and build/icon.ico.
// Zero deps beyond playwright (already a devDependency). Run from app/: `node scripts/build-icons.mjs`.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

const app = resolve(import.meta.dirname, '..')
const build = resolve(app, 'build')
const iconset = resolve(build, 'icon.iconset')

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const SMALL_MAX = 32
// Apple iconset file names → pixel size
const ICONSET = {
  'icon_16x16.png': 16,
  'icon_16x16@2x.png': 32,
  'icon_32x32.png': 32,
  'icon_32x32@2x.png': 64,
  'icon_128x128.png': 128,
  'icon_128x128@2x.png': 256,
  'icon_256x256.png': 256,
  'icon_256x256@2x.png': 512,
  'icon_512x512.png': 512,
  'icon_512x512@2x.png': 1024,
}
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

const svgLarge = readFileSync(resolve(build, 'icon.svg'), 'utf8')
const svgSmall = readFileSync(resolve(build, 'icon-small.svg'), 'utf8')

function sized(svg, n) {
  // Replace the root width/height so the SVG lays out at exactly n×n CSS pixels.
  return svg.replace(/<svg([^>]*?)\swidth="[^"]*"\sheight="[^"]*"/, `<svg$1 width="${n}" height="${n}"`)
}

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

async function render() {
  const browser = await launchChromium()
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const png = {}
  for (const n of SIZES) {
    const svg = sized(n <= SMALL_MAX ? svgSmall : svgLarge, n)
    await page.setViewportSize({ width: n, height: n })
    await page.setContent(
      `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`,
    )
    png[n] = await page.screenshot({ omitBackground: true, type: 'png', clip: { x: 0, y: 0, width: n, height: n } })
  }
  await browser.close()
  return png
}

function writeIco(png, out) {
  // ICO container with PNG-compressed entries (supported since Windows Vista).
  const entries = ICO_SIZES.map((n) => ({ n, buf: png[n] }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach(({ n, buf }, i) => {
    const o = i * 16
    dir.writeUInt8(n >= 256 ? 0 : n, o) // width (0 = 256)
    dir.writeUInt8(n >= 256 ? 0 : n, o + 1) // height (0 = 256)
    dir.writeUInt8(0, o + 2) // color palette
    dir.writeUInt8(0, o + 3) // reserved
    dir.writeUInt16LE(1, o + 4) // color planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32LE(buf.length, o + 8) // image size
    dir.writeUInt32LE(offset, o + 12) // image offset
    offset += buf.length
  })
  writeFileSync(out, Buffer.concat([header, dir, ...entries.map((e) => e.buf)]))
}

const png = await render()

rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })
for (const [name, n] of Object.entries(ICONSET)) writeFileSync(resolve(iconset, name), png[n])
console.log('wrote', iconset)

writeFileSync(resolve(build, 'icon.png'), png[1024])
console.log('wrote build/icon.png (1024)')

writeIco(png, resolve(build, 'icon.ico'))
console.log('wrote build/icon.ico', ICO_SIZES.join('/'))

if (process.platform === 'darwin') {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', resolve(build, 'icon.icns')], { stdio: 'inherit' })
  console.log('wrote build/icon.icns')
} else {
  console.log('skipped icon.icns (iconutil is macOS-only)')
}
