// 윈도우 설치본에 넣을 **Codex CLI** 를 공식 배포처에서 받아 app/resources/codex/ 에 푼다.
// 버전 고정 + SHA-256 대조 — 불일치면 실패한다(학생 PC 에서 조용히 다른 것을 쓰지 않게).
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
// **완성한 묶음만 성공·재사용한다**(검토 CODEX-BUNDLE-R1-02): 고지문 하나라도 못 받으면 실패이고,
// 임시 자리에서 다 만든 뒤에만 `resources/codex` 로 바꿔 넣는다. 완료 표식(`.complete`)은 맨
// 마지막에 쓰고, 재사용 판정은 그 표식 + 필수 파일(일반 파일인지까지)로 한다.
//
// 실행: `node scripts/fetch-codex.mjs` (또는 `pnpm fetch:codex`). 이미 완성돼 있으면 건너뛴다.
//   --force / CODEX_FORCE=1        다시 받는다
//   --version <v> / CODEX_VERSION  버전(기본은 아래 상수 — 올릴 때 여기와 해시를 함께 고친다)
//   --sha256 <hex> / CODEX_SHA256  기대 해시(기본은 아래 상수)
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { createGunzip } from 'node:zlib'

/**
 * 동봉 버전. 올릴 때: 아래 URL 로 받아 SHA-256 을 재고 이 두 상수를 함께 고친다.
 *
 * **0.163.0 이상이어야 한다**(윈도우 실기기 QA-01, 2026-10-27). 0.162.1 은 학생 PC 에 Codex 데스크톱
 * 앱이 함께 깔려 `[windows] sandbox = "elevated"` 이고 그 앱의 `node_repl.exe` 가 실행 중이면, 명령마다
 * 도는 샌드박스 권한 갱신(setup refresh)이 그 실행 파일을 쓰기 권한으로 열다 공유 위반(os error 32)으로
 * 실패해 **모든 셸 명령이** `helper_unknown_error: setup refresh had errors` 로 막혔다 — 대화는 되는데
 * 파일 도구가 하나도 안 돈다. 상류 수정은 openai/codex#51822(0.163.0 부터). 같은 기기에서 0.162.1 은
 * 실패, 0.164.0 은 통과를 번갈아 확인했다.
 */
export const DEFAULT_VERSION = '0.164.0'
/** `@openai/codex@<version>-win32-x64` tgz 의 SHA-256 (2026-10-27 실측, npm 레지스트리 sha1 과도 일치). */
export const DEFAULT_SHA256 = '4fbd23473a2fc223396cdd8490d3f658d368438134c12a3f1dac9d1e2041a65b'
export const TARGET = 'x86_64-pc-windows-msvc'
export const MARKER = '.complete'

export const tgzUrl = (version) => `https://registry.npmjs.org/@openai/codex/-/codex-${version}-win32-x64.tgz`

/** 함께 넣어야 하는 고지문. **하나라도 못 받으면 준비 실패다**(R1-02). */
export const NOTICE_FILES = [
  { file: 'LICENSE', url: (v) => `https://raw.githubusercontent.com/openai/codex/rust-v${v}/LICENSE` },
  { file: 'NOTICE', url: (v) => `https://raw.githubusercontent.com/openai/codex/rust-v${v}/NOTICE` },
  // codex-path/rg.exe 는 ripgrep 이다(Unlicense OR MIT).
  { file: 'LICENSE-ripgrep-MIT', url: () => 'https://raw.githubusercontent.com/BurntSushi/ripgrep/master/LICENSE-MIT' },
  { file: 'UNLICENSE-ripgrep', url: () => 'https://raw.githubusercontent.com/BurntSushi/ripgrep/master/UNLICENSE' }
]

/** 완성 묶음에 반드시 있어야 하는 것(경로는 resources/codex 기준). */
export const REQUIRED_FILES = [
  `vendor/${TARGET}/bin/codex.exe`,
  `vendor/${TARGET}/bin/codex-code-mode-host.exe`,
  `vendor/${TARGET}/codex-path/rg.exe`,
  `vendor/${TARGET}/codex-resources/codex-command-runner.exe`,
  `vendor/${TARGET}/codex-resources/codex-windows-sandbox-setup.exe`,
  `vendor/${TARGET}/codex-package.json`,
  ...NOTICE_FILES.map((n) => n.file),
  'BUNDLE.txt'
]

const sha256 = (file) =>
  new Promise((ok, fail) => {
    const h = createHash('sha256')
    createReadStream(file).on('error', fail).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex')))
  })

/** 필수 파일이 모두 있고, **심볼릭 링크가 아닌 일반 파일**인가(R1-03). */
export function hasRequiredFiles(dir) {
  for (const rel of REQUIRED_FILES) {
    const p = resolve(dir, rel)
    try {
      if (!lstatSync(p).isFile()) return { ok: false, why: `${rel} 이 일반 파일이 아니다(링크 등)` }
    } catch {
      return { ok: false, why: `${rel} 이 없다` }
    }
  }
  return { ok: true }
}

/** 다시 받지 않아도 되는가 — 완료 표식이 있고 버전·해시가 같고 필수 파일이 다 있는가. */
export function isComplete(dir, { version, sha256: expected }) {
  try {
    const m = JSON.parse(readFileSync(resolve(dir, MARKER), 'utf-8'))
    if (m.version !== version || m.sha256 !== expected) return { ok: false, why: '완료 표식의 버전·해시가 다르다' }
  } catch {
    return { ok: false, why: '완료 표식이 없다' }
  }
  return hasRequiredFiles(dir)
}

// ---------------------------------------------------------------- 아카이브 멤버 검사
//
// 추출은 호스트 `tar` 에 맡기지만, 그 전에 멤버 이름·종류를 직접 본다(절대경로 · 상위 이동 ·
// 링크 거부). gzip 스트림의 512바이트 헤더를 걸어가며 읽으므로 메모리에 다 올리지 않는다.

const BLOCK = 512
const ALLOWED_TYPES = new Set(['0', '\0', '5', 'x', 'g', 'L', 'K'])

function octal(buf) {
  const s = buf.toString('latin1').replace(/\0.*$/, '').trim()
  return s ? parseInt(s, 8) || 0 : 0
}

/** 이름 하나를 검사한다 — 절대경로·드라이브·상위 이동 거부. */
export function memberRejection(name, type) {
  if (!ALLOWED_TYPES.has(type)) return `허용하지 않는 멤버 종류 '${type}' (링크·장치 등): ${name}`
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return `절대경로 멤버: ${name}`
  if (name.split(/[\\/]/).includes('..')) return `상위 이동(..) 멤버: ${name}`
  return null
}

/** tgz 의 멤버 이름·종류를 순서대로 돌려준다. 링크나 이상한 경로가 있으면 던진다. */
export async function assertSafeArchive(tgzPath) {
  let pending = null // GNU long name('L')이 알려 준 다음 멤버의 진짜 이름
  let header = Buffer.alloc(0)
  const stream = createReadStream(tgzPath).pipe(createGunzip())
  let mode = 'header'
  let need = 0
  let current = { name: '', type: '0', size: 0 }
  let longBuf = Buffer.alloc(0)
  let count = 0
  for await (const chunk of stream) {
    let buf = chunk
    while (buf.length) {
      if (mode === 'header' || mode === 'skip') {
        if (mode === 'skip') {
          const take = Math.min(need, buf.length)
          buf = buf.subarray(take)
          need -= take
          if (need > 0) break
          mode = 'header'
          continue
        }
        const take = Math.min(BLOCK - header.length, buf.length)
        header = Buffer.concat([header.subarray(0, header.length), buf.subarray(0, take)])
        buf = buf.subarray(take)
        if (header.length < BLOCK) break
        const h = header
        header = Buffer.alloc(0)
        if (h.every((b) => b === 0)) continue // 끝 블록
        const rawName = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
        const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
        const size = octal(h.subarray(124, 136))
        const type = String.fromCharCode(h[156])
        const name = pending ?? (prefix ? `${prefix}/${rawName}` : rawName)
        pending = null
        if (type === 'L' || type === 'K') {
          // 데이터가 진짜 이름이다 — 다음 헤더에 이어 붙인다.
          longBuf = Buffer.alloc(0)
          current = { name, type, size }
          mode = 'readlong'
          need = size
          continue
        }
        const bad = memberRejection(name, type)
        if (bad) throw new Error(`아카이브 검사 실패 — ${bad}`)
        count++
        const skip = size + ((BLOCK - (size % BLOCK)) % BLOCK)
        if (skip > 0) {
          current = { name, type, size }
          mode = 'skip'
          need = skip
        }
      } else if (mode === 'readlong') {
        const take = Math.min(need, buf.length)
        longBuf = Buffer.concat([longBuf, buf.subarray(0, take)])
        buf = buf.subarray(take)
        need -= take
        if (need > 0) break
        pending = longBuf.toString('utf8').replace(/\0.*$/, '')
        mode = 'header'
      }
    }
  }
  return count
}

// ---------------------------------------------------------------- 준비

/**
 * 묶음을 준비한다. 성공해야만 `outDir` 이 바뀐다 — 임시 자리에서 완성하고 마지막에 바꿔 넣는다.
 * @returns {Promise<{reused?: boolean, skipped?: boolean, files?: number}>}
 */
export async function prepare(opts = {}) {
  const {
    platform = process.platform,
    version = DEFAULT_VERSION,
    sha256: expected = DEFAULT_SHA256,
    out = resolve(import.meta.dirname, '..', 'resources', 'codex'),
    fetchImpl = fetch,
    run = spawnSync,
    log = console.log
  } = opts

  if (platform !== 'win32') {
    mkdirSync(out, { recursive: true })
    log('codex bundle: 윈도우 전용이라 받지 않는다. 자리만 만듦 →', out)
    return { skipped: true }
  }
  if (!opts.force && isComplete(out, { version, sha256: expected }).ok) {
    log('codex bundle already complete →', out, '(use --force to re-download)')
    return { reused: true }
  }

  const staging = `${out}.staging`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const tgz = resolve(staging, 'codex.tgz')

  const url = tgzUrl(version)
  log('downloading', url)
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`download failed ${res.status} ${res.statusText} — is ${version}-win32-x64 published?`)
  await pipeline(res.body, createWriteStream(tgz))

  const digest = await sha256(tgz)
  if (digest !== expected) throw new Error(`sha256 mismatch\n  expected ${expected}\n  got      ${digest}`)
  log('sha256 verified')

  const members = await assertSafeArchive(tgz)
  log('archive checked:', members, 'members, no links/absolute/..')

  const r = run('tar', ['-xzf', tgz, '-C', staging, '--strip-components=1', `package/vendor/${TARGET}`], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`tar extraction failed (status ${r.status})`)
  rmSync(tgz, { force: true })

  // 고지문 — **하나라도 못 받으면 실패**다(선택이 아니다).
  for (const { file, url: mk } of NOTICE_FILES) {
    const u = mk(version)
    const res2 = await fetchImpl(u)
    if (!res2.ok) throw new Error(`notice download failed ${res2.status} ${res2.statusText}: ${u}`)
    writeFileSync(resolve(staging, file), await res2.text())
  }
  writeFileSync(
    resolve(staging, 'BUNDLE.txt'),
    [
      `OpenAI Codex CLI ${version} (${TARGET})`,
      '',
      `받은 곳: ${url}`,
      `태그: rust-v${version}`,
      `sha256: ${expected}`,
      '',
      '이 폴더는 app/scripts/fetch-codex.mjs 가 빌드 때 내려받아 푼 것이다(저장소에 실행 파일을 커밋하지 않는다).',
      '구성: vendor/ 아래에 codex.exe · codex-path/rg.exe(ripgrep) · codex-resources/* · codex-package.json.',
      'Codex CLI 는 Apache License 2.0 이고 전문은 LICENSE, 저작자 고지는 NOTICE 에 있다.',
      'ripgrep 은 Unlicense OR MIT 이고 LICENSE-ripgrep-MIT · UNLICENSE-ripgrep 에 있다.',
      ''
    ].join('\n')
  )

  const missing = hasRequiredFiles(staging)
  if (!missing.ok) throw new Error(`묶음이 불완전하다 — ${missing.why}`)
  // 완료 표식은 **맨 마지막**에 쓴다. 중간에 죽으면 표식이 없으니 다음 실행이 처음부터 다시 한다.
  writeFileSync(resolve(staging, MARKER), JSON.stringify({ version, sha256: expected, target: TARGET, files: REQUIRED_FILES.length }, null, 2))

  rmSync(out, { recursive: true, force: true })
  renameSync(staging, out)
  log('codex bundle →', out)
  return { files: REQUIRED_FILES.length }
}

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}

async function main() {
  try {
    await prepare({
      force: argv.includes('--force') || process.env.CODEX_FORCE === '1',
      version: flag('version') ?? process.env.CODEX_VERSION ?? DEFAULT_VERSION,
      sha256: (flag('sha256') ?? process.env.CODEX_SHA256 ?? DEFAULT_SHA256).toLowerCase()
    })
  } catch (e) {
    console.error(String(e?.message ?? e))
    process.exit(1)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()
