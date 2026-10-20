import type { ReactElement, SVGProps } from 'react'

export type IconName = 'folder' | 'layout' | 'check' | 'list' | 'doc' | 'box' | 'wrench' | 'gear' | 'lock' | 'refresh' | 'x' | 'arrow' | 'chevron' | 'chevronDown' | 'info' | 'warn' | 'done' | 'circle' | 'search' | 'files' | 'tool' | 'plus' | 'up' | 'down' | 'stop'

const PATHS: Record<IconName, ReactElement> = {
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />,
  layout: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 10h17M10 10v9.5" /></>,
  check: <><path d="M4 12.5l5 5L20 6.5" /></>,
  list: <><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></>,
  doc: <><path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z" /><path d="M14 3.5V8h4M8.5 12h7M8.5 16h7" /></>,
  box: <><path d="M3.5 8l8.5-4 8.5 4v8l-8.5 4-8.5-4z" /><path d="M3.5 8l8.5 4 8.5-4M12 12v8" /></>,
  wrench: <path d="M14.5 6.5a4 4 0 0 0 5 5l-9.5 9.5a2 2 0 0 1-3-3L16.5 8.5a4 4 0 0 0-2-2z" />,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.5" /></>,
  warn: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" /></>,
  done: <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></>,
  circle: <circle cx="12" cy="12" r="8.5" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  files: <><rect x="8" y="3.5" width="11" height="14" rx="1.5" /><path d="M5 6.5v12A1.5 1.5 0 0 0 6.5 20H16" /></>,
  tool: <><path d="M14.5 4.5a4.5 4.5 0 0 0-5.8 5.4L4 14.6V19h4.4l4.7-4.7a4.5 4.5 0 0 0 5.4-5.8l-3.2 3.2-2.1-.5-.5-2.1 1.8-4.6z" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  stop: <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" stroke="none" />
}

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {PATHS[name]}
    </svg>
  )
}
