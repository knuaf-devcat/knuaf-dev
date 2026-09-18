export function StatusPill({ status }: { status: string }) {
  const label: Record<string, string> = { pass: '통과', fail: '실패', blocked: '보류', pending: '대기', not_configured: '미설정', needs_user: '내 답변 필요', needs_evidence: '근거 필요', ready: '진행 가능' }
  return <span className={'pill ' + status}>{label[status] ?? status}</span>
}
export function SeverityPill({ severity }: { severity: string }) {
  return <span className={'pill ' + (severity === 'warning' ? 'warning' : '')}>{severity === 'warning' ? '경고' : '오류'}</span>
}
export function OwnerPill({ owner }: { owner: string }) {
  const label: Record<string, string> = { skill: '스킬', user: '나', professor: '교수' }
  return <span className="pill">{label[owner] ?? owner}</span>
}
