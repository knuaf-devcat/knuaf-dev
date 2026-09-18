export type Step = { id: string; title: string; body: string; state: 'done' | 'current' | 'next'; action?: { label: string; onClick: () => void } }

export function OnboardingStrip({ steps }: { steps: Step[] }) {
  return (
    <ol className="onboarding stagger" aria-label="시작 단계">
      {steps.map((s, i) => (
        <li key={s.id} className={`step ${s.state}`} style={{ ['--i' as string]: i }}>
          <span className="k">{s.state === 'done' ? '✓' : i + 1}</span>
          <span className="t">{s.title}</span>
          <span className="b">{s.body}</span>
          {s.action && s.state === 'current' && <div><button className="primary" onClick={s.action.onClick}>{s.action.label}</button></div>}
        </li>
      ))}
    </ol>
  )
}
