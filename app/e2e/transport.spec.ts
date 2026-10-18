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

test('stop 은 감싼 도구의 프로세스 트리까지 끝낸다 — 고아를 남기지 않는다 (W1 ①)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-transport-'))
  const pidFile = join(dir, 'tool.pid')
  const runner = join(dir, 'runner.mjs')
  // 도구 프로세스: 자기 pid 를 남기고 살아만 있는다(실제 codex/claude 자리).
  writeFileSync(runner, `import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.TOOL_PID_FILE, String(process.pid))\nsetInterval(() => {}, 1000)\n`, 'utf-8')
  writeCliShim(dir, 'fake',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(runner)}`,
    `"${process.execPath}" "${runner}"`)
  const binary = join(dir, process.platform === 'win32' ? 'fake.cmd' : 'fake')
  const rpc = new JsonRpcProcess(binary, [], dir, { ...process.env, TOOL_PID_FILE: pidFile })
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
})
