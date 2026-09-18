const DEFAULT_LABEL: Record<string, string> = {
  pass: '통과', fail: '실패', blocked: '보류', pending: '대기', not_configured: '미설정',
  needs_user: '내 답변 필요', needs_evidence: '근거 필요', ready: '진행 가능',
  empty: '비어 있음', drafting: '작성 중', review_ready: '검토 준비',
  error: '오류', warning: '경고', skill: '스킬', user: '나', professor: '교수'
}

/** Muted tint pill. `tone` picks the colour; `label` overrides the text. */
export function Badge({ tone, label, dot, changed }: { tone?: string; label?: string; dot?: boolean; changed?: boolean }) {
  const t = tone ?? ''
  return (
    <span className={`badge pop ${t}`} data-changed={changed ? 'true' : undefined}>
      {dot && <span className="dot" />}
      {label ?? DEFAULT_LABEL[t] ?? t}
    </span>
  )
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = status === 'pass' || status === 'installed' ? 'pass' : status === 'fail' || status === 'missing' ? 'fail' : status === 'blocked' ? 'blocked' : status === 'warning' ? 'warning' : ''
  return <Badge tone={tone || undefined} label={label ?? DEFAULT_LABEL[status] ?? status} />
}
