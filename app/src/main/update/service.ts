import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { downloadToFile } from '../runtimeDownload'
import { compatible, verifySkill, version, type VerifiedSkill } from './manifest'
import { type UpdateConfig } from './keys'
import { boundedFetch, downloadLimit, readChannel, type Transport } from './network'
import { SkillStore } from './store'
import { skillSwitch, type SkillSwitch } from './switch'
import { agentActivity } from './activity'

export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'repair' | 'ready' | 'needs-app' | 'downloading' | 'switching' | 'error' | 'unavailable'
  current: string; bundled: boolean; highest: string | null; available: string | null
  kept: string[]; received?: number; total?: number; message?: string
}
export class SkillUpdates {
  private candidate: VerifiedSkill | null = null
  private controller: AbortController | null = null
  private checking: Promise<UpdateStatus> | null = null
  private statusValue: UpdateStatus
  private readonly lock: SkillSwitch
  constructor(readonly store: SkillStore, private opts: {
    config: UpdateConfig; fetch: Transport; restartSidecar: () => Promise<unknown>
    emit?: (status: UpdateStatus) => void; lock?: SkillSwitch
  }) {
    this.lock = opts.lock ?? skillSwitch
    this.statusValue = { phase: opts.config.keys.length ? 'idle' : 'unavailable', current: store.bundledVersion, bundled: true, highest: null, available: null, kept: [], ...(!opts.config.keys.length ? { message: '업데이트를 확인할 수 없어요.' } : {}) }
  }
  status(): UpdateStatus {
    try {
      const s = this.store.state(), source = this.store.resolveSkillSource()
      return { ...this.statusValue, current: source === this.store.bundled ? this.store.bundledVersion : s.active!, bundled: source === this.store.bundled, highest: s.highest?.version ?? null, kept: Object.keys(s.kept).filter(v => this.store.valid(v, s.kept[v])) }
    } catch { return { ...this.statusValue, current: this.store.bundledVersion, bundled: true, kept: [] } }
  }
  private set(patch: Partial<UpdateStatus>): UpdateStatus {
    this.statusValue = { ...this.statusValue, received: undefined, total: undefined, message: undefined, ...patch }
    const status = this.status(); this.opts.emit?.(status); return status
  }
  check(): Promise<UpdateStatus> {
    if (this.checking) return this.checking
    if (this.controller || this.lock.switching) return Promise.resolve(this.status())
    const task = this.checkNow()
    this.checking = task
    void task.finally(() => { if (this.checking === task) this.checking = null })
    return task
  }
  private async checkNow(): Promise<UpdateStatus> {
    if (!this.opts.config.keys.length) return this.set({ phase: 'unavailable', message: '업데이트를 확인할 수 없어요.', available: null })
    this.set({ phase: 'checking' })
    try {
      const p = await readChannel(this.opts.config, this.opts.fetch, AbortSignal.timeout(15_000))
      this.candidate = p
      if (!compatible(p.manifest, this.store.appVersion)) return this.set({ phase: 'needs-app', available: p.manifest.version, message: '이 규칙집은 앱 새 판이 필요해요.' })
      const kind = this.store.disposition(p)
      return this.set({ phase: kind === 'new' ? 'available' : kind === 'repair' ? 'repair' : 'ready', available: p.manifest.version })
    } catch (error) {
      this.candidate = null
      return this.set({ phase: 'error', available: null, message: error instanceof Error ? error.message : '업데이트를 확인하지 못했어요.' })
    }
  }
  async install(): Promise<UpdateStatus> {
    agentActivity.ensureActive()
    if (this.controller || this.checking || this.lock.switching) throw new Error('이미 업데이트 작업 중이에요.')
    if (!this.candidate) throw new Error('먼저 업데이트를 확인해 주세요.')
    const p = verifySkill(this.candidate.envelope, this.opts.config.keys)
    const kind = this.store.disposition(p)
    if (kind === 'kept') return this.select(p.manifest.version)
    const controller = new AbortController()
    this.controller = controller
    const deadline = setTimeout(() => controller.abort(), 120_000)
    let temp: string | null = null
    try {
      mkdirSync(this.store.root, { recursive: true })
      temp = mkdtempSync(join(this.store.root, '.download-'))
      const zip = join(temp, 'skill.zip')
      this.set({ phase: 'downloading' })
      await downloadToFile(p.manifest.url, zip, p.manifest, event => this.set({ phase: 'downloading', received: event.received, total: event.total }), controller.signal, {
        fetch: (url, init) => boundedFetch(url, init.signal, this.opts.fetch, downloadLimit(p.manifest.size), this.opts.config)
      })
      if (controller.signal.aborted) throw new Error('업데이트를 취소했어요.')
      const bytes = readFileSync(zip)
      if (this.store.state().active === p.manifest.version) {
        // A repair must not replace scripts underneath a still-running call.
        return await this.lock.switch(async () => {
          if (controller.signal.aborted) throw new Error('업데이트를 취소했어요.')
          this.store.publish(p, bytes)
          return this.activateLocked(p.manifest.version, controller.signal)
        })
      }
      this.store.publish(p, bytes)
      return await this.activate(p.manifest.version, controller.signal)
    } catch (error) {
      this.set({ phase: 'error', message: error instanceof Error ? error.message : '규칙집 업데이트에 실패했어요.' })
      throw error
    } finally {
      clearTimeout(deadline)
      if (temp) rmSync(temp, { recursive: true, force: true })
      this.controller = null
    }
  }
  cancel(): boolean { if (!this.controller) return false; this.controller.abort(); return true }
  async select(v: string | null): Promise<UpdateStatus> {
    if (v !== null) version(v)
    agentActivity.ensureActive()
    if (this.controller || this.checking) throw new Error('이미 업데이트 작업 중이에요.')
    return this.activate(v)
  }
  rollback(): Promise<UpdateStatus> { return this.select(this.store.rollbackTarget()) }
  private async activate(v: string | null, signal?: AbortSignal): Promise<UpdateStatus> {
    agentActivity.ensureActive()
    return this.lock.switch(() => this.activateLocked(v, signal))
  }
  private async activateLocked(v: string | null, signal?: AbortSignal): Promise<UpdateStatus> {
    if (signal?.aborted) throw new Error('업데이트를 취소했어요.')
    const previous = this.store.resolveSkillSource() === this.store.bundled ? null : this.store.state().active
    this.set({ phase: 'switching' })
    try {
      this.store.select(v)
      if (signal?.aborted) throw new Error('업데이트를 취소했어요.')
      await this.opts.restartSidecar()
      return this.set({ phase: 'ready' })
    } catch (error) {
      // Restore effective previous selection even after a complete newer .tmp.
      this.store.select(previous)
      await this.opts.restartSidecar()
      this.set({ phase: 'error', message: error instanceof Error ? error.message : '규칙집을 바꾸지 못했어요.' })
      throw error
    }
  }
}
