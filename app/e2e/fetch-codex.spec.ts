// app/scripts/fetch-codex.mjs 시험 — 준비가 **완전한 묶음**만 성공으로 치는지(검토 CODEX-BUNDLE-R1-02),
// 그리고 아카이브 경계를 지키는지(R1-03). 합성 tgz + 대역 fetch 로 네트워크 없이 돌린다.
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

interface Mod {
  DEFAULT_VERSION: string
  DEFAULT_SHA256: string
  TARGET: string
  MARKER: string
  NOTICE_FILES: { file: string; url: (v: string) => string }[]
  REQUIRED_FILES: string[]
  tgzUrl: (v: string) => string
  prepare: (o: Record<string, unknown>) => Promise<{ skipped?: boolean; reused?: boolean; files?: number }>
  isComplete: (dir: string, o: { version: string; sha256: string }) => { ok: boolean; why?: string }
  hasRequiredFiles: (dir: string) => { ok: boolean; why?: string }
  memberRejection: (name: string, type: string) => string | null
  assertSafeArchive: (p: string) => Promise<number>
}

const load = async (): Promise<Mod> =>
  (await import(pathToFileURL(resolve(__dirname, '..', 'scripts', 'fetch-codex.mjs')).href)) as unknown as Mod

// ---------------------------------------------------------------- 합성 tar.gz

function tarEntry(name: string, opts: { data?: Buffer; type?: string; linkname?: string } = {}): Buffer {
  const data = opts.data ?? Buffer.alloc(0)
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write('0000644\0', 100, 8, 'latin1')
  h.write('0000000\0', 108, 8, 'latin1')
  h.write('0000000\0', 116, 8, 'latin1')
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1')
  h.write('00000000000\0', 136, 12, 'latin1')
  h.write('        ', 148, 8, 'latin1')
  h.write(opts.type ?? '0', 156, 1, 'latin1')
  h.write('ustar\0' + '00', 257, 8, 'latin1')
  if (opts.linkname) h.write(opts.linkname, 157, 100, 'utf8')
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1')
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512)
  return Buffer.concat([h, data, pad])
}

function makeTgz(entries: { name: string; data?: Buffer; type?: string; linkname?: string }[]): Buffer {
  return gzipSync(Buffer.concat([...entries.map((e) => tarEntry(e.name, e)), Buffer.alloc(1024)]))
}

/** 동봉 계약을 채우는 최소 파일들(내용은 아무거나 — 검사는 존재·일반 파일 여부만 본다). */
function contractEntries(target: string): { name: string; data?: Buffer; type?: string }[] {
  const p = `package/vendor/${target}`
  return [
    { name: `${p}/codex-package.json`, data: Buffer.from('{"layoutVersion":1}\n') },
    { name: `${p}/bin/codex.exe`, data: Buffer.from('MZ fake\n') },
    { name: `${p}/bin/codex-code-mode-host.exe`, data: Buffer.from('MZ fake\n') },
    { name: `${p}/codex-path/rg.exe`, data: Buffer.from('MZ fake\n') },
    { name: `${p}/codex-resources/codex-command-runner.exe`, data: Buffer.from('MZ fake\n') },
    { name: `${p}/codex-resources/codex-windows-sandbox-setup.exe`, data: Buffer.from('MZ fake\n') }
  ]
}

const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

const response = (status: number, body: Buffer | string) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  text: async () => String(body),
  body: Readable.from([Buffer.from(body)])
})

/** URL 조각으로 응답을 정한다. 없는 것은 404. */
function fakeFetch(routes: { match: string; status?: number; body?: Buffer | string }[]) {
  return async (url: string) => {
    for (const r of routes) if (url.includes(r.match)) return response(r.status ?? 200, r.body ?? '')
    return response(404, 'not found')
  }
}

const noticeRoutes = (mod: Mod, version: string, overrides: Record<string, { status: number }> = {}) =>
  mod.NOTICE_FILES.map((n) => ({ match: n.url(version).replace(/^https:\/\/[^/]+/, ''), status: overrides[n.file]?.status ?? 200, body: `# ${n.file}\n` }))

test.describe('fetch-codex 준비 판정 (CODEX-BUNDLE-R1-02)', () => {
  test('정상: 필수 파일·고지문·완료 표식을 갖춘 묶음만 만든다', async () => {
    const mod = await load()
    const base = mkdtempSync(join(tmpdir(), 'kd-fx-'))
    const out = join(base, 'resources', 'codex')
    const tgz = makeTgz(contractEntries(mod.TARGET))
    await mod.prepare({
      platform: 'win32', out, version: '1.2.3', sha256: sha(tgz),
      fetchImpl: fakeFetch([{ match: mod.tgzUrl('1.2.3'), body: tgz }, ...noticeRoutes(mod, '1.2.3')])
    })
    for (const rel of mod.REQUIRED_FILES) expect(existsSync(join(out, rel)), rel).toBe(true)
    expect(existsSync(join(out, mod.MARKER))).toBe(true)
    expect(mod.isComplete(out, { version: '1.2.3', sha256: sha(tgz) }).ok).toBe(true)
    expect(existsSync(`${out}.staging`)).toBe(false)   // 임시 자리는 남지 않는다
    // 두 번째 실행은 같은 완성 묶음을 다시 받지 않는다.
    const again = await mod.prepare({ platform: 'win32', out, version: '1.2.3', sha256: sha(tgz), fetchImpl: fakeFetch([]) })
    expect(again.reused).toBe(true)
  })

  test('반례 A: NOTICE 가 503 이면 준비 실패 — 선택 파일이 아니다', async () => {
    const mod = await load()
    const base = mkdtempSync(join(tmpdir(), 'kd-fx503-'))
    const out = join(base, 'resources', 'codex')
    const tgz = makeTgz(contractEntries(mod.TARGET))
    await expect(mod.prepare({
      platform: 'win32', out, version: '1.2.3', sha256: sha(tgz),
      fetchImpl: fakeFetch([{ match: mod.tgzUrl('1.2.3'), body: tgz }, ...noticeRoutes(mod, '1.2.3', { NOTICE: { status: 503 } })])
    })).rejects.toThrow(/notice download failed 503/)
    expect(existsSync(join(out, mod.MARKER))).toBe(false)
    expect(existsSync(join(out, 'NOTICE'))).toBe(false)
    expect(mod.isComplete(out, { version: '1.2.3', sha256: sha(tgz) }).ok).toBe(false)
  })

  test('반례 B: 중간 실패는 아무것도 남기지 않고, 재실행이 처음부터 완성한다', async () => {
    const mod = await load()
    const base = mkdtempSync(join(tmpdir(), 'kd-fxretry-'))
    const out = join(base, 'resources', 'codex')
    const tgz = makeTgz(contractEntries(mod.TARGET))
    // 1회차: LICENSE 실패. 추출은 이미 끝났지만 out 으로 넘어가지 않는다.
    await expect(mod.prepare({
      platform: 'win32', out, version: '1.2.3', sha256: sha(tgz),
      fetchImpl: fakeFetch([{ match: mod.tgzUrl('1.2.3'), body: tgz }, ...noticeRoutes(mod, '1.2.3', { LICENSE: { status: 500 } })])
    })).rejects.toThrow(/notice download failed 500/)
    expect(existsSync(out)).toBe(false)   // 부분 산출물이 묶음 자리에 남지 않는다

    // 그 상태에서 손으로 codex.exe 만 남긴 묶음도 성공으로 보지 않는다(완료 표식 + 필수 파일 계약).
    const forged = join(base, 'forged')
    mkdirSync(join(forged, 'vendor', mod.TARGET, 'bin'), { recursive: true })
    writeFileSync(join(forged, 'vendor', mod.TARGET, 'bin', 'codex.exe'), 'MZ\n')
    expect(mod.isComplete(forged, { version: '1.2.3', sha256: sha(tgz) })).toMatchObject({ ok: false })
    writeFileSync(join(forged, mod.MARKER), JSON.stringify({ version: '1.2.3', sha256: sha(tgz) }))
    expect(mod.isComplete(forged, { version: '1.2.3', sha256: sha(tgz) }).ok).toBe(false)  // 표식만으로는 부족

    // 2회차(정상): 처음부터 다시 받아 완성한다.
    await mod.prepare({
      platform: 'win32', out, version: '1.2.3', sha256: sha(tgz),
      fetchImpl: fakeFetch([{ match: mod.tgzUrl('1.2.3'), body: tgz }, ...noticeRoutes(mod, '1.2.3')])
    })
    expect(mod.isComplete(out, { version: '1.2.3', sha256: sha(tgz) }).ok).toBe(true)
    for (const n of mod.NOTICE_FILES) expect(existsSync(join(out, n.file)), n.file).toBe(true)
  })

  test('해시가 다르면 추출 전에 실패한다', async () => {
    const mod = await load()
    const base = mkdtempSync(join(tmpdir(), 'kd-fxsha-'))
    const out = join(base, 'resources', 'codex')
    const tgz = makeTgz(contractEntries(mod.TARGET))
    await expect(mod.prepare({
      platform: 'win32', out, version: '1.2.3', sha256: 'deadbeef'.repeat(8),
      fetchImpl: fakeFetch([{ match: mod.tgzUrl('1.2.3'), body: tgz }])
    })).rejects.toThrow(/sha256 mismatch/)
    expect(existsSync(out)).toBe(false)
  })
})

test.describe('fetch-codex 아카이브 경계 (CODEX-BUNDLE-R1-03)', () => {
  test('링크 멤버가 든 아카이브는 거부하고 아무것도 만들지 않는다', async () => {
    const mod = await load()
    const base = mkdtempSync(join(tmpdir(), 'kd-fxlink-'))
    const out = join(base, 'resources', 'codex')
    const escape = join(base, 'outside.txt')
    writeFileSync(escape, 'x')
    const tgz = makeTgz([
      ...contractEntries(mod.TARGET),
      { name: `package/vendor/${mod.TARGET}/bin/evil.exe`, type: '2', linkname: escape }
    ])
    await expect(mod.prepare({
      platform: 'win32', out, version: '1.2.3', sha256: sha(tgz),
      fetchImpl: fakeFetch([{ match: mod.tgzUrl('1.2.3'), body: tgz }, ...noticeRoutes(mod, '1.2.3')])
    })).rejects.toThrow(/아카이브 검사 실패/)
    expect(existsSync(out)).toBe(false)
  })

  test('절대경로·상위 이동 멤버도 거부한다 (단위)', async () => {
    const mod = await load()
    expect(mod.memberRejection(`package/vendor/${mod.TARGET}/bin/codex.exe`, '0')).toBeNull()
    expect(mod.memberRejection(`package/vendor/${mod.TARGET}/bin/codex.exe`, '2')).toMatch(/멤버 종류/)
    expect(mod.memberRejection('/etc/passwd', '0')).toMatch(/절대경로/)
    expect(mod.memberRejection('C:/Windows/system32/x.dll', '0')).toMatch(/절대경로/)
    expect(mod.memberRejection(`package/vendor/${mod.TARGET}/../../evil`, '0')).toMatch(/상위 이동/)
  })

  test('완성 검사는 심볼릭 링크를 일반 파일로 보지 않는다', async () => {
    const mod = await load()
    const dir = mkdtempSync(join(tmpdir(), 'kd-fxsym-'))
    for (const rel of mod.REQUIRED_FILES) {
      const p = join(dir, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, 'x')
    }
    writeFileSync(join(dir, mod.MARKER), JSON.stringify({ version: '1.2.3', sha256: 'a'.repeat(64) }))
    expect(mod.hasRequiredFiles(dir).ok).toBe(true)
    // 실행 파일 하나를 링크로 바꾸면 완성이 아니다.
    const exe = join(dir, `vendor/${mod.TARGET}/bin/codex.exe`)
    const real = join(dir, 'real.exe')
    writeFileSync(real, 'x')
    chmodSync(real, 0o755)
    // 기존 파일을 지우고 링크로 대체(rm 없이 rename 으로 자리 비우기).
    const { renameSync } = await import('node:fs')
    renameSync(exe, join(dir, 'old.exe'))
    symlinkSync(real, exe)
    expect(mod.hasRequiredFiles(dir)).toMatchObject({ ok: false })
  })

  test('윈도우가 아니면 받지 않고 자리만 만든다 (맥 불변)', async () => {
    const mod = await load()
    const base = mkdtempSync(join(tmpdir(), 'kd-fxmac-'))
    const out = join(base, 'resources', 'codex')
    const r = await mod.prepare({ platform: 'darwin', out })
    expect(r.skipped).toBe(true)
    expect(existsSync(out)).toBe(true)
    expect(existsSync(join(out, mod.MARKER))).toBe(false)
  })
})
