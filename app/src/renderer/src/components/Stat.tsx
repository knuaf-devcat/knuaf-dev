export function Stat({ value, label, tone }: { value: number | string; label: string; tone?: 'ok' | 'bad' | 'blocked' }) {
  return <div className={`stat ${tone ?? ''}`}><span className="v num">{value}</span><span className="l">{label}</span></div>
}
export function Stats({ children }: { children: React.ReactNode }) { return <div className="stats">{children}</div> }
