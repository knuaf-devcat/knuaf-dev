import { join } from 'node:path'
import { openStore, withStore, type OpenStore, type StoreSession } from './appStore'
import type { InstallerLaunch } from './nativeInstaller'
import { downloadToFile } from '../runtimeDownload'
import { compare, exact, object, version, type Envelope } from './manifest'
import { parseApp, releasePage, verifyApp, type VerifiedApp } from './appManifest'
import { boundedFetch, readChannelDocument, type Transport } from './network'
import type { UpdateConfig } from './keys'
import type { AppHandoff } from './handoff'
export interface AppUpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'preparing' | 'launching' | 'interrupted' | 'error' | 'unavailable'
  current: string; latest: string | null; page: string | null; message?: string; received?: number; total?: number
}
interface Pending { from: string; to: string; installer: string; at: string }
export class AppUpdates {
  private candidate: VerifiedApp | null = null
  private controller: AbortController | null = null
  private checking: Promise<AppUpdateStatus> | null = null
  private statusValue: AppUpdateStatus
  readonly root: string
  readonly ready: Promise<void>
  constructor(private opts: {
    userData: string; current: string; platform: NodeJS.Platform; arch: string; config: UpdateConfig; fetch: Transport
    handoff: Pick<AppHandoff, 'run'>; startInstaller: (request: InstallerLaunch) => Promise<void>; quit: () => void; openStore?: OpenStore
    openExternal: (url: string) => Promise<unknown>; emit?: (status: AppUpdateStatus) => void
  }) {
    version(opts.current)
    this.root = join(opts.userData, 'app-update')
    this.statusValue = { phase: opts.config.keys.length ? 'idle' : 'unavailable', current: opts.current, latest: null, page: null, ...(!opts.config.keys.length ? { message: '업데이트를 확인할 수 없어요.' } : {}) }
    this.ready = this.recover()
  }
  status(): AppUpdateStatus { return { ...this.statusValue } }
  private set(patch: Partial<AppUpdateStatus>): AppUpdateStatus {
    this.statusValue = { ...this.statusValue, message: undefined, received: undefined, total: undefined, ...patch }
    this.opts.emit?.(this.status()); return this.status()
  }
  private installer(v: string): string { version(v); return join(this.root, v, 'installer.exe') }
  private inStore<T>(create: boolean, action: (store: StoreSession) => Promise<T>): Promise<T> {
    return withStore(this.opts.openStore ?? openStore, this.opts.userData, create, action)
  }
  private async recover(): Promise<void> {
    if (this.opts.platform !== 'win32') return
    try {
      await this.inStore(false, async store => {
        const text = await store.read('pending.json')
        if (text === null) return
        const p = object(JSON.parse(text)); exact(p, ['from', 'to', 'installer', 'at']); version(p.from); version(p.to)
        if (compare(p.to, p.from) <= 0 || p.installer !== this.installer(p.to) || typeof p.at !== 'string' || new Date(p.at).toISOString() !== p.at) throw new Error('앱 설치 기록이 잘못됐어요.')
        const pending = p as unknown as Pending
        if (this.opts.current === pending.to) {
          await store.cleanup(pending.to); await store.remove('pending.json')
          this.set({ phase: this.opts.config.keys.length ? 'idle' : 'unavailable', message: '앱 업데이트를 마쳤어요.' })
        } else if (this.opts.current === pending.from) {
          const text = await store.read(`${pending.to}/manifest.json`)
          if (text === null) throw new Error('앱 설치 서명 기록이 없어요.')
          this.candidate = verifyApp(JSON.parse(text), this.opts.config.keys, this.opts.current)
          if (this.candidate.manifest.version !== pending.to) throw new Error('앱 설치 기록과 서명이 달라요.')
          this.set({ phase: 'interrupted', latest: pending.to, page: releasePage(pending.to), message: '업데이트가 끝나지 않았어요. 다시 시도할 수 있어요.' })
        } else throw new Error('앱 설치 기록과 현재 판이 달라요.')
      })
    } catch (error) { this.set({ phase: this.opts.config.keys.length ? 'error' : 'unavailable', message: error instanceof Error ? error.message : '설치 기록을 확인하지 못했어요.' }) }
  }
  check(): Promise<AppUpdateStatus> {
    if (this.checking) return this.checking
    if (this.controller) return Promise.resolve(this.status())
    const task = this.checkNow(); this.checking = task
    void task.finally(() => { if (this.checking === task) this.checking = null })
    return task
  }
  private async checkNow(): Promise<AppUpdateStatus> {
    await this.ready
    if (!this.opts.config.keys.length) return this.set({ phase: 'unavailable', message: '업데이트를 확인할 수 없어요.' })
    this.set({ phase: 'checking' })
    try {
      const channel = await readChannelDocument(this.opts.config, this.opts.fetch, AbortSignal.timeout(15_000)), app = object(channel.app)
      version(app.latest)
      const page = releasePage(app.latest)
      if (app.page !== page) throw new Error('허용되지 않은 앱 내려받기 페이지예요.')
      if (this.opts.platform === 'win32' && this.opts.arch === 'x64') {
        const proof = parseApp(app['win32-x64'], this.opts.config.keys)
        if (app.latest !== proof.manifest.version) throw new Error('채널 판과 서명된 앱 판이 달라요.')
        this.candidate = proof
      } else if (this.opts.platform !== 'darwin') return this.set({ phase: 'unavailable', latest: null, page: null, message: '이 운영체제의 앱 업데이트는 지원하지 않아요.' })
      if (compare(app.latest, this.opts.current) <= 0) return this.set({ phase: 'idle', latest: null, page: null })
      return this.set({ phase: 'available', latest: app.latest, page })
    } catch (error) {
      return this.set({ phase: 'error', message: error instanceof Error ? error.message : '앱 업데이트를 확인하지 못했어요.' })
    }
  }
  async openPage(): Promise<void> {
    if (this.opts.platform !== 'darwin' || !this.statusValue.latest || !this.statusValue.page) throw new Error('먼저 앱 업데이트를 확인해 주세요.')
    const page = releasePage(this.statusValue.latest)
    if (page !== this.statusValue.page || compare(this.statusValue.latest, this.opts.current) <= 0) throw new Error('앱 내려받기 페이지가 잘못됐어요.')
    await this.opts.openExternal(page)
  }
  cancel(): boolean {
    if (!this.controller || this.statusValue.phase === 'launching') return false
    this.controller.abort(); return true
  }
  async install(): Promise<void> {
    await this.ready
    if (this.opts.platform !== 'win32' || this.opts.arch !== 'x64') throw new Error('Windows x64 앱에서만 설치할 수 있어요.')
    if (this.controller || this.checking) throw new Error('이미 앱 업데이트를 준비하고 있어요.')
    if (!this.candidate) throw new Error('먼저 앱 업데이트를 확인해 주세요.')
    const p = verifyApp(this.candidate.envelope, this.opts.config.keys, this.opts.current), v = p.manifest.version, installer = this.installer(v)
    const controller = new AbortController(); this.controller = controller
    let pendingWritten = false, launchUnknown = false, started = false
    try {
      await this.inStore(true, async store => {
        if (!await store.verify(v, p.manifest.size, p.manifest.sha256)) {
          this.set({ phase: 'downloading' })
          const sink = await store.download(v, p.manifest.size, p.manifest.sha256)
          await downloadToFile(p.manifest.url, installer, p.manifest, event => this.set({ phase: 'downloading', received: event.received, total: event.total }), controller.signal, {
            fetch: (url, init) => boundedFetch(url, init.signal, this.opts.fetch, p.manifest.size, this.opts.config),
            createStream: () => sink
          })
          await store.commit(v)
        }
        await store.write(`${v}/manifest.json`, p.envelope satisfies Envelope)
      })
      this.set({ phase: 'preparing' })
      await this.opts.handoff.run(async () => {
        if (controller.signal.aborted) throw new Error('앱 업데이트를 취소했어요.')
        await this.inStore(false, async store => {
          await store.write('pending.json', { from: this.opts.current, to: v, installer, at: new Date().toISOString() })
          pendingWritten = true
          const proof = verifyApp(p.envelope, this.opts.config.keys, this.opts.current)
          if (!await store.verify(v, proof.manifest.size, proof.manifest.sha256)) throw new Error('실행 직전 설치 파일 확인에 실패했어요.')
        })
        if (controller.signal.aborted) throw new Error('앱 업데이트를 취소했어요.')
        this.set({ phase: 'launching' })
        try { await this.opts.startInstaller({ userData: this.opts.userData, path: installer, version: v, size: p.manifest.size, sha256: p.manifest.sha256 }); started = true }
        catch (error) { launchUnknown = !!error && typeof error === 'object' && 'code' in error && error.code === 'installer_unknown'; throw error }
      }, controller.signal)
      // No persistence or asynchronous work follows confirmed process creation.
      this.opts.quit()
    } catch (error) {
      if (pendingWritten && !started && !launchUnknown) {
        try { await this.inStore(false, store => store.remove('pending.json')) } catch { /* preserve the record if its boundary cannot be proved */ }
      }
      this.set({ phase: 'error', message: error instanceof Error ? error.message : '앱 업데이트에 실패했어요. 다시 시도할 수 있어요.' })
      throw error
    } finally { this.controller = null }
  }
}
