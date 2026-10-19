// 윈도우 설치본에 넣을 **Codex CLI** 를 공식 배포처에서 받아 app/resources/codex/ 에 푼다.
// 버전 고정 + SHA-256 대조 — 불일치면 빌드가 실패한다(students PC 에서 조용히 다른 것을 쓰지 않게).
//
// 왜 npm 레지스트리의 플랫폼 패키지인가 (GitHub 릴리스 자산이 아니라):
//   codex.exe 는 **자기 패키지 레이아웃**을 스스로 검사한다 — 바이너리 안에
//   `codex-package.json`(entrypoint · resourcesDir · pathDir)과 `codex-path/rg.exe`,
//   `codex-resources/codex-command-runner.exe` 같은 경로가 들어 있고, 없으면
//   "Install ripgrep or repair the bundled Codex package." 로 검색 기능이 죽는다.
//   GitHub 릴리스의 `codex-x86_64-pc-windows-msvc.exe` 는 그 레이아웃이 아니라 단일 실행 파일이다.
//   그래서 윈도우에 실제로 설치되는 모습과 **같은 쪽**(플랫폼 패키지 전체)을 고른다.
//   이 패키지는 OpenAI 가 공식 배포하는 곳(npm 레지스트리, `@openai/codex`)이고, 받는 것은
//   HTTPS + 버전 고정 URL 이며 npm 을 패키지 관리자로 쓰지 않는다(설치도 하지 않는다).
//
// 맥·리눅스에서는 **받지 않는다** — 형님 범위 결정이 "윈도우 설치본만"이고, 맥 설치본·맥 동작은
// 그대로 둔다. 대신 빈 디렉터리만 만들어 electron-builder 의 extraResources `from` 이 늘
// 존재하게 한다(없는 경로를 가리키는 설정으로 빌드가 흔들리지 않게).
//
// 실행: `node scripts/fetch-codex.mjs` (또는 `pnpm fetch:codex`). 이미 있으면 건너뛴다.
//   --force / CODEX_FORCE=1      다시 받는다
//   --version <v> / CODEX_VERSION  버전(기본은 아래 상수 — 올릴 때 여기와 해시를 함께 고친다)
//   --sha256 <hex> / CODEX_SHA256  기대 해시(기본은 아래 상수)
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'

/** 동봉 버전. 올릴 때: 아래 URL 로 받아 SHA-256 을 재고 이 두 상수를 함께 고친다. */
const DEFAULT_VERSION = '0.162.1'
/** `@openai/codex@<version>-win32-x64` tgz 의 SHA-256 (2026-10-19 실측). */
const DEFAULT_SHA256 = '5d48824f11a512b0ecb351461c2e90a1040c80de1026bc4a80815d5121f3936d'

const TARGET = 'x86_64-pc-windows-msvc'
const TAG = `rust-v${DEFAULT_VERSION}`

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const force = argv.includes('--force') || process.env.CODEX_FORCE === '1'
const version = flag('version') ?? process.env.CODEX_VERSION ?? DEFAULT_VERSION
const expected = (flag('sha256') ?? process.env.CODEX_SHA256 ?? DEFAULT_SHA256).toLowerCase()

const app = resolve(import.meta.dirname, '..')
const out = resolve(app, 'resources', 'codex')
const vendor = resolve(out, 'vendor', TARGET)
const marker = resolve(vendor, 'bin', 'codex.exe')

if (process.platform !== 'win32') {
  mkdirSync(out, { recursive: true })
  console.log('codex bundle: 윈도우 전용이라 받지 않는다. 자리만 만듦 →', out)
  process.exit(0)
}

if (!force && existsSync(marker)) {
  console.log('codex bundle already present →', out, '(use --force to re-download)')
  process.exit(0)
}

const url = `https://registry.npmjs.org/@openai/codex/-/codex-${version}-win32-x64.tgz`
const tmp = resolve(app, 'resources', `codex-${version}-win32-x64.tgz`)
mkdirSync(resolve(app, 'resources'), { recursive: true })

console.log('downloading', url)
const res = await fetch(url)
if (!res.ok) {
  console.error(`download failed ${res.status} ${res.statusText} — is ${version}-win32-x64 published?`)
  process.exit(1)
}
await pipeline(res.body, createWriteStream(tmp))

const digest = await new Promise((ok, fail) => {
  const h = createHash('sha256')
  createReadStream(tmp).on('error', fail).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex')))
})
if (digest !== expected) {
  rmSync(tmp, { force: true })
  console.error(`sha256 mismatch\n  expected ${expected}\n  got      ${digest}`)
  process.exit(1)
}
console.log('sha256 verified')

rmSync(out, { recursive: true, force: true })
mkdirSync(vendor, { recursive: true })
// 패키지 안 `package/vendor/<target>/**` 를 그대로 푼다 — layoutVersion 1 의 상대 배치
// (bin/ · codex-path/ · codex-resources/)를 유지해야 codex 가 자기 패키지를 찾는다.
const r = spawnSync('tar', ['-xzf', tmp, '-C', out, '--strip-components=1', `package/vendor/${TARGET}`], { stdio: 'inherit' })
if (r.status !== 0) {
  console.error('tar extraction failed (status', r.status, ')')
  process.exit(r.status ?? 1)
}
if (!existsSync(marker)) {
  console.error('extracted, but', marker, 'is missing — check the archive layout')
  process.exit(1)
}

// 고지문. Apache-2.0 동봉이므로 라이선스 전문과 구성 요소 안내를 함께 넣는다(공식 배포처에서 받는다).
async function grab(url, file) {
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`license download failed ${res.status} ${res.statusText}: ${url}`)
    process.exit(1)
  }
  writeFileSync(resolve(out, file), await res.text())
}
await grab(`https://raw.githubusercontent.com/openai/codex/${TAG}/LICENSE`, 'LICENSE')
const notice = await fetch(`https://raw.githubusercontent.com/openai/codex/${TAG}/NOTICE`)
if (notice.ok) writeFileSync(resolve(out, 'NOTICE'), await notice.text())
// codex-path/rg.exe 는 ripgrep 이다(Unlicense OR MIT). 플랫폼 패키지에 라이선스 파일이 없어
// ripgrep 배포본의 전문을 함께 넣는다.
await grab('https://raw.githubusercontent.com/BurntSushi/ripgrep/master/LICENSE-MIT', 'LICENSE-ripgrep-MIT')
await grab('https://raw.githubusercontent.com/BurntSushi/ripgrep/master/UNLICENSE', 'UNLICENSE-ripgrep')
writeFileSync(
  resolve(out, 'BUNDLE.txt'),
  [
    `OpenAI Codex CLI ${version} (${TARGET})`,
    '',
    `받은 곳: ${url}`,
    `태그: ${TAG}`,
    `sha256: ${expected}`,
    '',
    '이 폴더는 app/scripts/fetch-codex.mjs 가 빌드 때 내려받아 푼 것이다(저장소에 실행 파일을 커밋하지 않는다).',
    '구성: vendor/ 아래에 codex.exe · codex-path/rg.exe(ripgrep) · codex-resources/* · codex-package.json.',
    'Codex CLI 는 Apache License 2.0 이고 전문은 LICENSE 에 있다. ripgrep 은 Unlicense OR MIT 이고',
    'LICENSE-ripgrep-MIT · UNLICENSE-ripgrep 에 있다.',
    ''
  ].join('\n')
)
rmSync(tmp, { force: true })
console.log('codex bundle →', out)
