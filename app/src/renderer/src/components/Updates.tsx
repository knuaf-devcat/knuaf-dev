import { useEffect, useId, useRef, useState } from 'react'
import { create } from 'zustand'
import { CLOSE_LABEL, UPDATE } from '../copy'
import { Icon } from './Icon'
type UpdateStatus = Parameters<Parameters<Window['knuaf']['update']['onStatus']>[0]>[0]
type PreloadAppUpdateStatus = Parameters<Parameters<Window['knuaf']['appUpdate']['onStatus']>[0]>[0]
// The main process supports owner-blocked status; preload's public type predates it.
type AppUpdateStatus = Omit<PreloadAppUpdateStatus, 'phase'> & {
  phase: PreloadAppUpdateStatus['phase'] | 'blocked'
  reason?: 'store_owner'
}

interface UpdatesState {
  skill: UpdateStatus | null
  app: AppUpdateStatus | null
  dialog: boolean
  setSkill: (skill: UpdateStatus) => void
  setApp: (app: AppUpdateStatus) => void
  setDialog: (dialog: boolean) => void
}
export const useUpdates = create<UpdatesState>(set => ({
  skill: null, app: null, dialog: false,
  setSkill: skill => set({ skill }), setApp: app => set({ app }), setDialog: dialog => set({ dialog })
}))

let users = 0
let stop: (() => void) | null = null
/** One shared subscription; an event received during the initial read wins over the snapshot. */
export function useUpdateSubscription(): void {
  useEffect(() => {
    users++
    if (users === 1) {
      let live = true, skillEvents = 0, appEvents = 0
      const offSkill = window.knuaf.update.onStatus(status => { skillEvents++; useUpdates.getState().setSkill(status) })
      const offApp = window.knuaf.appUpdate.onStatus(status => { appEvents++; useUpdates.getState().setApp(status) })
      void window.knuaf.update.status().then(r => { if (live && !skillEvents && 'result' in r) useUpdates.getState().setSkill(r.result) })
      void window.knuaf.appUpdate.status().then(r => { if (live && !appEvents && 'result' in r) useUpdates.getState().setApp(r.result) })
      stop = () => { live = false; offSkill(); offApp() }
    }
    return () => { if (--users === 0) { stop?.(); stop = null } }
  }, [])
}

export function AppUpdateDialog() {
  const app = useUpdates(s => s.app)
  const open = useUpdates(s => s.dialog)
  const setOpen = useUpdates(s => s.setDialog)
  const [failure, setFailure] = useState(false)
  const mac = window.knuaf.platform === 'darwin'
  const blocked = app?.phase === 'blocked'
  const ownerBlocked = blocked && app?.reason === 'store_owner'
  const [pageFailure, setPageFailure] = useState(false)
  const busy = app && ['downloading', 'preparing', 'launching'].includes(app.phase)
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  const progress = app?.phase === 'downloading' ? UPDATE.appDownloading
    : app?.phase === 'preparing' ? UPDATE.appPreparing : UPDATE.appLaunching
  const act = async () => {
    if (useUpdates.getState().app?.phase === 'blocked') return
    setFailure(false)
    try {
      const r = mac ? await window.knuaf.appUpdate.openPage() : await window.knuaf.appUpdate.install()
      if (useUpdates.getState().app?.phase === 'blocked') return
      if ('error' in r) setFailure(true)
      else if (mac) setOpen(false)
    } catch { setFailure(true) }
  }
  const openBlockedPage = async () => {
    setPageFailure(false)
    try { const r = await window.knuaf.appUpdate.openPage(); if ('error' in r) setPageFailure(true) } catch { setPageFailure(true) }
  }
  return <dialog ref={ref} className="sheet" aria-labelledby={titleId}
    onClose={(e) => { if (e.target === ref.current) setOpen(false) }}
    onClick={(e) => { if (e.target === ref.current) setOpen(false) }}>
    <div className="sheet-head"><div className="row"><h2 id={titleId}>{blocked && !app?.latest ? UPDATE.appBlockedTitle : UPDATE.appTitle(app?.latest ?? '')}</h2></div>
      <button className="quiet" aria-label={CLOSE_LABEL} onClick={() => setOpen(false)}><Icon name="x" /></button>
    </div>
    <div className="sheet-body">
      <p>{blocked ? ownerBlocked ? UPDATE.appOwnerBlocked : UPDATE.appBlockedOther : mac ? UPDATE.appMac : UPDATE.appWindows}</p>
      {busy && <p role="status">{progress}{app?.phase === 'downloading' && app.total ? ` ${Math.round((app.received ?? 0) / app.total * 100)}%` : ''}</p>}
      {!blocked && (failure || app?.phase === 'error' || app?.phase === 'interrupted') && <p role="alert">{app?.message || UPDATE.appFailed}</p>}
      {blocked && pageFailure && <p role="alert">{UPDATE.appPageFailed}</p>}
      {busy && app?.phase !== 'launching' && <button onClick={() => void window.knuaf.appUpdate.cancel()}>{UPDATE.cancel}</button>}
      {ownerBlocked && <button onClick={() => void window.knuaf.openGuide()}>{UPDATE.appGuide}</button>}
    </div>
    <div className="sheet-foot">
      <button onClick={() => setOpen(false)}>{UPDATE.later}</button>
      {blocked ? ownerBlocked && <button className="primary" onClick={() => void openBlockedPage()}>{UPDATE.appOpen}</button>
        : <button className="primary" disabled={!!busy || !app?.latest} onClick={() => void act()}>{failure || app?.phase === 'interrupted' || app?.phase === 'error' ? UPDATE.retry : mac ? UPDATE.appOpen : UPDATE.appInstall}</button>}
    </div>
  </dialog>
}

export function UpdateSettings() {
  useUpdateSubscription()
  const skill = useUpdates(s => s.skill)
  const app = useUpdates(s => s.app)
  const setDialog = useUpdates(s => s.setDialog)
  const [working, setWorking] = useState(false)
  const [appPageFailure, setAppPageFailure] = useState(false)
  const ownerBlocked = app?.phase === 'blocked' && app.reason === 'store_owner'
  const openBlockedPage = async () => {
    setAppPageFailure(false)
    try { const r = await window.knuaf.appUpdate.openPage(); if ('error' in r) setAppPageFailure(true) } catch { setAppPageFailure(true) }
  }
  const [failure, setFailure] = useState(false)
  const retry = useRef<(() => Promise<{ result: unknown } | { error: { code: string; message: string } }>) | null>(null)
  const run = async (op: () => Promise<{ result: unknown } | { error: { code: string; message: string } }>) => {
    retry.current = op
    setWorking(true); setFailure(false)
    try { const r = await op(); if ('error' in r) setFailure(true) } catch { setFailure(true) } finally { setWorking(false) }
  }
  const busy = working || !!skill && ['checking', 'downloading', 'switching'].includes(skill.phase)
  const appAvailable = !!app?.latest && ['available', 'interrupted', 'error', 'downloading', 'preparing', 'launching'].includes(app.phase)
  const message = !skill || skill.phase === 'checking' ? UPDATE.checking
    : skill.phase === 'unavailable' ? UPDATE.unavailable
    : failure ? UPDATE.failed
    : skill.phase === 'available' && skill.available ? UPDATE.available(skill.available)
    : skill.phase === 'repair' ? UPDATE.repair
    : skill.phase === 'needs-app' ? UPDATE.needsApp
    : skill.phase === 'downloading' ? UPDATE.downloading
    : skill.phase === 'switching' ? UPDATE.switching
    : skill.phase === 'error' || failure ? UPDATE.failed : UPDATE.ready
  const appMessage = !app || app.phase === 'checking' ? UPDATE.appChecking
    : app.phase === 'downloading' ? UPDATE.appDownloading
    : app.phase === 'preparing' ? UPDATE.appPreparing
    : app.phase === 'launching' ? UPDATE.appLaunching
    : app?.phase === 'blocked' ? UPDATE.appBlockedStatus
    : appAvailable ? UPDATE.appAvailable : app.phase === 'idle' ? UPDATE.appLatest : UPDATE.appUnknown
  return <section aria-label={UPDATE.title} style={{ marginTop: 'var(--sp-3)' }}>
    <h3>{UPDATE.title}</h3>
    <p>{skill ? UPDATE.current(skill.current, skill.bundled) : UPDATE.checking}</p>
    <p role="status">{message}{skill?.phase === 'downloading' && skill.total ? ` ${Math.round((skill.received ?? 0) / skill.total * 100)}%` : ''}</p>
    {skill?.phase === 'needs-app' && !appAvailable && !ownerBlocked && <p className="caption">{UPDATE.needsAppWait}</p>}
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <button disabled={!!busy} onClick={() => void run(async () => { if (useUpdates.getState().app?.phase === 'blocked') return window.knuaf.update.check(); const [s] = await Promise.all([window.knuaf.update.check(), window.knuaf.appUpdate.check()]); return s })}>{UPDATE.check}</button>
      {skill && ['available', 'repair'].includes(skill.phase) && <button disabled={!!busy} onClick={() => void run(() => window.knuaf.update.install())}>{skill.phase === 'repair' ? UPDATE.retry : UPDATE.install}</button>}
      {(skill?.phase === 'error' || failure) && <button disabled={!!busy} onClick={() => void run(retry.current ?? (() => window.knuaf.update.check()))}>{UPDATE.retry}</button>}
      {skill?.phase === 'downloading' && <button onClick={() => void window.knuaf.update.cancel()}>{UPDATE.cancel}</button>}
      {skill && !skill.bundled && <button disabled={!!busy} onClick={() => void run(() => window.knuaf.update.rollback())}>{UPDATE.rollback}</button>}
      {skill?.kept.filter(v => v !== skill.current).map(v => <button key={v} disabled={!!busy} onClick={() => void run(() => window.knuaf.update.select(v))}>{UPDATE.select(v)}</button>)}
      {skill?.phase === 'needs-app' && appAvailable && <button onClick={() => window.knuaf.platform === 'darwin' && !['downloading', 'preparing', 'launching'].includes(app!.phase) ? void run(() => window.knuaf.appUpdate.openPage()) : setDialog(true)}>{window.knuaf.platform === 'darwin' && !['downloading', 'preparing', 'launching'].includes(app!.phase) ? UPDATE.appOpen : UPDATE.appButton}</button>}
    </div>
    <p className="caption">{app ? UPDATE.app(app.current, appMessage) : UPDATE.appChecking}</p>
    {app?.phase === 'blocked' && <p>{ownerBlocked ? UPDATE.appOwnerBlocked : UPDATE.appBlockedOther}</p>}
    {ownerBlocked && <div className="row">
      <button onClick={() => void openBlockedPage()}>{UPDATE.appOpen}</button>
      <button onClick={() => void window.knuaf.openGuide()}>{UPDATE.appGuide}</button>
    </div>}
    {ownerBlocked && appPageFailure && <p role="alert">{UPDATE.appPageFailed}</p>}
  </section>
}
