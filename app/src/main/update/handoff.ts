import { agentActivity, type AgentActivity } from './activity'
import { skillSwitch, type SkillSwitch } from './switch'
import type { ProcessSnapshot } from './processes'
export interface HandoffChat { hasPendingLogin(): boolean; flushDrafts(): void; closeForUpdate(confirmStopped: () => Promise<void>): Promise<void> }
export interface HandoffWindows { captureOwned(): Promise<ProcessSnapshot>; confirmStopped(before: ProcessSnapshot): Promise<void>; assertResourcesIdle(): Promise<void> }
export class AppHandoff {
  private recoveryPending = false
  constructor(private opts: {
    chat: HandoffChat; sidecar: { stop(): Promise<void>; restart(): Promise<unknown> }
    windows: HandoffWindows; activity?: AgentActivity; lock?: SkillSwitch; timeout?: number
  }) {}
  /** Pause is synchronous with lock acquisition, and survives through launch or full recovery. */
  async run(transfer: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    const activity = this.opts.activity ?? agentActivity, lock = this.opts.lock ?? skillSwitch
    const timeout = this.opts.timeout ?? 30_000, start = Date.now()
    if (this.recoveryPending) {
      await this.opts.sidecar.restart()
      this.recoveryPending = false
      activity.resume()
    }
    activity.suspend()
    let committed = false
    try {
      if (this.opts.chat.hasPendingLogin()) throw new Error('브라우저에서 진행 중인 로그인을 마친 뒤 다시 눌러 주세요.')
      await lock.switch(async () => {
        await activity.drain(Math.max(0, timeout - (Date.now() - start)))
        if (signal?.aborted) throw new Error('앱 업데이트를 취소했어요.')
        const owned = await this.opts.windows.captureOwned()
        try {
          await this.opts.sidecar.stop()
          await this.opts.chat.closeForUpdate(() => this.opts.windows.confirmStopped(owned))
          await this.opts.windows.assertResourcesIdle()
          if (signal?.aborted) throw new Error('앱 업데이트를 취소했어요.')
          this.opts.chat.flushDrafts()
          await transfer()
          committed = true
        } catch (error) {
          try { await this.opts.sidecar.restart() }
          catch (recovery) {
            this.recoveryPending = true
            throw new AggregateError([error, recovery], '앱 업데이트를 멈췄지만 실행기 복구를 완료하지 못했어요. 다시 시도해 주세요.')
          }
          throw error
        }
      }, timeout)
    } finally {
      // Successful transfer exits the app; no new process may enter in that interval.
      if (!committed && !this.recoveryPending) activity.resume()
    }
  }
}
