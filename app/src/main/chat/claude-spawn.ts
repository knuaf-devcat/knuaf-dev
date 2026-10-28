import { spawn } from 'node:child_process'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { killTree, winSpawn } from '../win'

/** SDK 기본 spawn은 .cmd/.bat를 실행하지 못한다. 이 경우에만 기존 Windows 경로를 쓴다. */
export function claudeSpawnOptions(
  binary: string,
  platform: NodeJS.Platform = process.platform
): Pick<Options, 'spawnClaudeCodeProcess'> {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) return {}
  return { spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
    const spec = winSpawn(command, args, platform)
    const child = spawn(spec.command, spec.args, {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], ...spec.options
    })
    // SDK의 기본 spawner도 stderr를 소비한다. 읽지 않으면 파이프가 차서 대화가 멈춘다.
    child.stderr.resume()
    let killed = false
    const kill = (s: NodeJS.Signals = 'SIGTERM') => {
      killed = true
      killTree(child, s)
      return true
    }
    // SDK가 stdin EOF + 유예 뒤 전달하는 신호다. Node의 signal 옵션은 cmd.exe만
    // 죽이므로 직접 받는다. SDK의 close()/최종 kill도 같은 트리 종료 경로로 보낸다.
    const abort = () => { kill() }
    signal.addEventListener('abort', abort, { once: true })
    child.once('close', () => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
    return {
      stdin: child.stdin, stdout: child.stdout,
      get killed() { return killed || child.killed },
      get exitCode() { return child.exitCode },
      get signalCode() { return child.signalCode },
      kill,
      on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child)
    }
  } }
}
