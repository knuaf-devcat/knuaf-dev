// Legacy names kept for screens not yet migrated.
import { Badge, StatusBadge } from './Badge'
export function StatusPill({ status }: { status: string }) { return <StatusBadge status={status} /> }
export function SeverityPill({ severity }: { severity: string }) { return <Badge tone={severity === 'warning' ? 'warning' : ''} label={severity === 'warning' ? '경고' : '오류'} /> }
export function OwnerPill({ owner }: { owner: string }) { return <Badge label={{ skill: '스킬', user: '나', professor: '교수' }[owner] ?? owner} /> }
