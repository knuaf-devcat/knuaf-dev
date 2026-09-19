import { useEffect, useState } from 'react'
import { useProject } from '../store/project'
import { Feedback } from '../components/Feedback'
import { OnboardingStrip, type Step } from '../components/OnboardingStrip'
import { ProjectCard } from '../components/ProjectCard'
import { EmptyState } from '../components/EmptyState'
import { Disclosure } from '../components/Disclosure'
import { CREDIT, EMPTY, ONBOARDING_STEPS, SCREEN_INTRO, relativeTime } from '../copy'
import type { ProjectPeek, RecentEntry } from '../../../shared/types'

export function Home() {
  const { open, settings, error, loading, root, hasProject, status, peek, depsReady, setScreen, loadSettings } = useProject()
  const [showCredit, setShowCredit] = useState(false)
  const [typed, setTyped] = useState('')
  const [peeks, setPeeks] = useState<Record<string, ProjectPeek>>({})
  useEffect(() => {
    if (settings && !settings.credit_shown_at) {
      setShowCredit(true)
      void window.knuaf.setSettings({ credit_shown_at: new Date().toISOString() })
    }
  }, [settings])
  useEffect(() => {
    let alive = true
    void (async () => {
      const out: Record<string, ProjectPeek> = {}
      for (const r of settings?.recent ?? []) out[r.root] = await window.knuaf.peekProject(r.root)
      if (alive) setPeeks(out)
    })()
    return () => { alive = false }
  }, [settings?.recent])
  const pick = async () => { const dir = await window.knuaf.pickFolder(); if (dir) await open(dir) }
  const remove = async (r: string) => { await window.knuaf.setSettings({ recent: (settings?.recent ?? []).filter((x) => x.root !== r) }); await loadSettings() }

  const revision = status?.revision ?? peek?.revision ?? null
  const showOnboarding = !(root && hasProject && (revision ?? 0) >= 1)
  const steps: Step[] = showOnboarding ? ONBOARDING_STEPS.map((s, i) => {
    const done = i === 0 ? !!root : i === 1 ? depsReady === true : false
    const current = !done && (i === 0 || (i === 1 && !!root) || (i === 2 && !!root && depsReady === true))
    return {
      id: s.id, title: s.title, body: s.body, state: done ? 'done' : current ? 'current' : 'next',
      action: i === 1 ? { label: s.actionLabel ?? '패키지 준비', onClick: () => setScreen('troubleshoot') } : i === 2 ? { label: '내 논문으로', onClick: () => setScreen('chat') } : undefined
    }
  }) : []

  return (
    <div>
      <h1 className="display" style={{ paddingTop: 'var(--titlebar-h)' }}>논문 작업 폴더</h1>
      <p className="intro">{SCREEN_INTRO.home}</p>
      {showCredit && <div className="credit">{CREDIT.line1}<br />{CREDIT.line2}</div>}
      {error && <Feedback kind={error.kind} title={error.title} body={error.action} details={<code>{error.raw}</code>} />}
      {showOnboarding && <OnboardingStrip steps={steps} />}
      <div className="row" style={{ margin: 'var(--sp-4) 0' }}>
        <button className="primary" onClick={pick} disabled={loading}>폴더 열기…</button>
        {loading ? <span className="caption">여는 중…</span> : <span className="caption">폴더를 이 창에 끌어다 놓아도 돼요.</span>}
      </div>
      <Disclosure label="경로 붙여넣기">
        <div className="row">
          <input aria-label="폴더 경로" style={{ minWidth: 360 }} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="/Users/…/논문 작업" onKeyDown={(e) => { if (e.key === 'Enter' && typed) void open(typed) }} />
          <button onClick={() => typed && open(typed)} disabled={loading || !typed}>경로로 열기</button>
        </div>
      </Disclosure>
      <h2>최근 폴더</h2>
      {(settings?.recent ?? []).length === 0 ? (
        <EmptyState icon="folder" title={EMPTY.recent.title} body={EMPTY.recent.body} />
      ) : (
        <div className="projects stagger">
          {(settings?.recent ?? []).map((r: RecentEntry, i) => {
            const p = peeks[r.root]
            return <ProjectCard key={r.root} index={i} root={r.root} openedAt={relativeTime(r.opened_at)} revision={p?.revision ?? null} exists={p ? p.exists : true} hasProject={p?.hasProject ?? false} onOpen={() => open(r.root)} onRemove={() => remove(r.root)} />
          })}
        </div>
      )}
    </div>
  )
}
