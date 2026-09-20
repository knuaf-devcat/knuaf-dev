import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

/** stdio JSON-RPC. stderr stays out of the student transcript and credentials never enter logs. */
export class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams
  private seq = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  closed = false
  /** 자식이 왜 죽었는지는 stderr 에만 남는다. 진단용으로 꼬리만 보관한다(무한 증가 금지). */
  lastStderr = ''
  onNotification: (method: string, params: any) => void = () => {}
  onRequest: (id: number | string, method: string, params: any) => void = () => {}
  onClose: () => void = () => {}
  constructor(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(binary, args, { cwd, env, stdio: 'pipe' })
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      let m: any
      try { m = JSON.parse(line) } catch { return }
      if (m.method) {
        if (m.id !== undefined) this.onRequest(m.id, m.method, m.params)
        else this.onNotification(m.method, m.params)
      } else if (this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!; clearTimeout(p.timer); this.pending.delete(m.id)
        m.error ? p.reject(new Error(m.error.message ?? 'AI 요청 실패')) : p.resolve(m.result)
      }
    })
    this.child.stderr.on('data', (d: Buffer) => {
      this.lastStderr = (this.lastStderr + d.toString()).slice(-2000).trim()
    })
    this.child.on('error', () => this.finish())
    // 'exit'로 끝낸다 — 'close'는 stdio 파이프가 다 닫혀야 오는데, 에이전트가 띄운
    // 손자 프로세스가 파이프를 물고 있으면 부모가 죽어도 오지 않는다(앱 종료가 멈춤).
    this.child.on('exit', () => this.finish())
    this.child.stdin.on('error', () => this.finish())
  }
  private finish() {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('AI 연결이 종료됐어요. 전송 중이던 답변은 자동으로 다시 보내지 않아요.')) }
    this.pending.clear(); this.onClose()
  }
  send(value: unknown) {
    if (this.closed) throw new Error('AI 연결이 종료됐어요.')
    this.child.stdin.write(JSON.stringify(value) + '\n')
  }
  request(method: string, params: unknown = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('AI 응답 시간이 초과됐어요. 전송 상태를 확인해 주세요.')) }, 45_000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ id, method, params }) } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }
  async stop() {
    if (this.closed) return
    await new Promise<void>(resolve => {
      // 죽는 것('exit')만 기다린다. 'close'는 파이프 점유자 때문에 안 올 수 있다.
      const done = () => { clearTimeout(t1); clearTimeout(t2); resolve() }
      const t1 = setTimeout(() => { try { this.child.kill('SIGKILL') } catch { /* already gone */ } }, 3000)
      const t2 = setTimeout(done, 3500)
      this.child.once('exit', done)
      this.child.kill('SIGTERM')
    })
  }
}
