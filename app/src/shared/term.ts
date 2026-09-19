/** IPC shapes for the embedded agent terminals (main/terminal.ts). Shared so preload + renderer
 * can type the bridge without pulling the node-pty implementation into the web typecheck. */
export type TermKind = 'claude' | 'codex'

export interface TermInfo {
  id: string
  root: string
  kind: TermKind
  alive: boolean
  exitCode?: number
  pid?: number
}

export interface TermOpenOpts {
  revision: number | null
  resume?: boolean
  cols: number
  rows: number
}
