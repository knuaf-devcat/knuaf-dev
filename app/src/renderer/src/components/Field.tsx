import type { ReactNode } from 'react'

/** Label / control / trailing action with inline validation (aria-describedby). */
export function Field({ id, label, children, trailing, help, invalid }: { id: string; label: string; children: ReactNode; trailing?: ReactNode; help?: ReactNode; invalid?: string | null }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div>{children}</div>
      {trailing ?? <span />}
      {(invalid || help) && <div id={`${id}-help`} className={`help ${invalid ? 'invalid' : ''}`}>{invalid ?? help}</div>}
    </div>
  )
}

const ABS = /^(\/|[A-Za-z]:[\\/]|\\\\)/
/** Validate a project-relative output path: no escaping, right extension, must be new. */
export function validateOutPath(value: string, ext: string[], exists: (p: string) => boolean): string | null {
  if (!value.trim()) return '이름을 적어 주세요.'
  if (ABS.test(value) || value.split(/[\\/]/).includes('..')) return '작업 폴더 안의 상대 경로만 쓸 수 있어요.'
  if (ext.length && !ext.some((e) => value.toLowerCase().endsWith(e))) return `확장자는 ${ext.join(', ')} 이어야 해요.`
  if (exists(value)) return '같은 이름이 이미 있어요. 다른 이름으로 저장하세요.'
  return null
}
