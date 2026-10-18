// Unit test for src/main/chat/transport.ts — plain Playwright `test()` in Node: no Electron.
//
// 윈도우에서 `winSpawn` 은 `.cmd`/`.bat` 를 `cmd.exe` 로 감싼다. 그러면 transport 의 자식은
// cmd.exe 이고 실제 도구는 **손자**다 — stop() 이 cmd.exe 만 죽이면 도구가 고아로 남는다
// (윈도우 CI 4차: 잡 정리에서 `Terminate orphan process: node`). 이 시험이 그 반례를 고정한다.
import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonRpcProcess } from '../src/main/chat/transport'
import { taskkillPath } from '../src/main/win'
import { writeCliShim } from './fixtures/fake-codex'

/** 살아 있는지 — 신호 0 은 죽이지 않고 존재만 본다. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
async function until(ok: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 20)) }
  return ok()
}

/**
 * 가짜 도구(자기 pid 를 남기고 살아 있는다)를 transport 로 띄우고 stop 한 뒤, 그 프로세스가
 * 죽었는지 본다. 윈도우에서는 `winSpawn` 이 cmd.exe 로 감싸므로 이 pid 는 **손자**다.
 */
async function expectTreeKilled(env: NodeJS.ProcessEnv): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kd-transport-'))
  const pidFile = join(dir, 'tool.pid')
  const runner = join(dir, 'runner.mjs')
  writeFileSync(runner, `import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.TOOL_PID_FILE, String(process.pid))\nsetInterval(() => {}, 1000)\n`, 'utf-8')
  writeCliShim(dir, 'fake',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(runner)}`,
    `"${process.execPath}" "${runner}"`)
  const binary = join(dir, process.platform === 'win32' ? 'fake.cmd' : 'fake')
  const rpc = new JsonRpcProcess(binary, [], dir, { ...env, TOOL_PID_FILE: pidFile })
  try {
    expect(await until(() => existsSync(pidFile)), '가짜 도구가 뜨지 않았다').toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf-8'))
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid), '가짜 도구가 살아 있지 않다').toBe(true)

    await rpc.stop()

    // stop 뒤에 도구 프로세스가 살아 있으면 안 된다 — 윈도우에서 cmd.exe 만 죽이면 고아로 남는다.
    expect(await until(() => !alive(pid)), 'stop 뒤에도 도구 프로세스가 살아 있다(고아)').toBe(true)
  } finally {
    void rpc.stop().catch(() => {})
  }
}

test('stop 은 감싼 도구의 프로세스 트리까지 끝낸다 — 고아를 남기지 않는다 (W1 ①)', async () => {
  await expectTreeKilled(process.env)
})

/**
 * 윈도우 CI 5차의 반례: 앱이 좁은 PATH 로 떠 있으면(PATH 에 System32 없음) `taskkill` 을
 * **이름으로** 찾던 종전 구현은 못 찾아 cmd.exe 만 죽였고 손자가 살아남았다. 이제는 절대
 * 경로(`SystemRoot\System32\taskkill.exe`)로 부르므로 PATH 와 무관하다.
 */
test('PATH 에 System32 가 없어도 트리째 끝낸다 — taskkill 절대 경로 (W1 ①)', async () => {
  const saved = process.env.PATH
  process.env.PATH = mkdtempSync(join(tmpdir(), 'kd-nopath-'))   // System32 가 없는 PATH
  try {
    await expectTreeKilled(process.env)
  } finally {
    if (saved === undefined) delete process.env.PATH
    else process.env.PATH = saved
  }
})

test('taskkill 경로는 SystemRoot → windir → C:\\Windows 순 (W1 ①)', () => {
  expect(taskkillPath({ SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\taskkill.exe')
  expect(taskkillPath({ windir: 'E:\\Win' })).toBe('E:\\Win\\System32\\taskkill.exe')
  expect(taskkillPath({ SystemRoot: 'F:\\W', windir: 'E:\\Win' }), 'SystemRoot 가 먼저다').toBe('F:\\W\\System32\\taskkill.exe')
  expect(taskkillPath({})).toBe('C:\\Windows\\System32\\taskkill.exe')
  // 끝 구분자가 있어도 두 번 붙지 않는다.
  expect(taskkillPath({ SystemRoot: 'G:\\Windows\\' })).toBe('G:\\Windows\\System32\\taskkill.exe')
})
