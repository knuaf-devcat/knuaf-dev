import { win32 } from 'node:path'
export interface ProcessInfo { pid: number; parent: number; created: string; name: string; path: string | null }
/** Native enumeration expands 8.3 paths first; ambiguous aliases must never be guessed. */
export function windowsPath(value: string): string {
  let p = value.replaceAll('/', '\\')
  if (p.toLowerCase().startsWith('\\\\?\\unc\\')) p = '\\\\' + p.slice(8)
  else if (p.startsWith('\\\\?\\')) p = p.slice(4)
  if (!win32.isAbsolute(p) || /(?:^|\\)[^\\]*~\d/.test(p) || p.includes('\0')) throw new Error('프로세스 경로를 확인하지 못했어요.')
  return win32.normalize(p).replace(/\\+$/, '').toLowerCase()
}
export function resourcesBusy(processes: ProcessInfo[], resources: string, names: readonly string[]): boolean {
  const root = windowsPath(resources), prefix = root + '\\', known = new Set(names.map(n => n.toLowerCase()))
  return processes.some(p => {
    if (!p.path) return known.has(p.name.toLowerCase())
    try { const path = windowsPath(p.path); return path === root || path.startsWith(prefix) }
    catch { return known.has(p.name.toLowerCase()) }
  })
}
export interface ProcessSnapshot { processes: ProcessInfo[]; appPid: number; appExecutable: string }
type Ownership = 'owned' | 'unrelated' | 'unknown'
interface Generation { process: ProcessInfo; ownership: Ownership }
/** Retain generations, including dead parents. Every new orphan must be owned or
 * provably unrelated; an unobserved intermediate parent is NOT evidence of safety. */
export class OwnedProcessWatch {
  private history = new Map<number, Generation[]>()
  private app: string
  private times = new Map<string, string | null>()
  constructor(private snapshot: ProcessSnapshot) {
    this.app = windowsPath(snapshot.appExecutable)
    const ids = new Set([snapshot.appPid])
    let changed = true
    while (changed) {
      changed = false
      for (const p of snapshot.processes) if (!ids.has(p.pid) && ids.has(p.parent)) { ids.add(p.pid); changed = true }
    }
    for (const process of snapshot.processes) this.remember(process, ids.has(process.pid) ? 'owned' : 'unrelated')
  }
  private time(value: string): string | null {
    if (this.times.has(value)) return this.times.get(value)!
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{1,7})Z$/.exec(value)
    // Windows FILETIME has 100ns precision. Date.parse alone truncates it to ms
    // and can attribute an older orphan to a newer, unrelated reused parent PID.
    const result = match && Number.isFinite(Date.parse(value)) ? `${match[1]}.${match[2].padEnd(7, '0')}Z` : null
    this.times.set(value, result); return result
  }
  private sameGeneration(a: ProcessInfo, b: ProcessInfo): boolean {
    return a.created === b.created && (this.time(a.created) !== null || (a.parent === b.parent && a.name === b.name && a.path === b.path))
  }
  private remember(process: ProcessInfo, ownership: Ownership): void {
    const generations = this.history.get(process.pid) ?? []
    const existing = generations.find(g => this.sameGeneration(g.process, process))
    if (existing) existing.ownership = ownership
    else { generations.push({ process, ownership }); this.history.set(process.pid, generations) }
  }
  busy(processes: ProcessInfo[]): boolean {
    const current = new Map(processes.map(p => [p.pid, p])), known = new Map<number, Ownership>(), visiting = new Set<number>()
    const before = (parent: ProcessInfo, child: ProcessInfo): boolean => {
      const a = this.time(parent.created), b = this.time(child.created)
      return a !== null && b !== null && a <= b
    }
    const classify = (p: ProcessInfo): Ownership => {
      if (p.pid === this.snapshot.appPid) return 'owned'
      const cached = known.get(p.pid); if (cached) return cached
      if (visiting.has(p.pid)) return 'unknown'
      visiting.add(p.pid)
      const old = this.history.get(p.pid)?.find(g => this.sameGeneration(g.process, p))
      let ownership: Ownership = old?.ownership ?? 'unknown'
      if (!old || ownership === 'unknown') {
        const parent = current.get(p.parent)
        // A live matching parent generation proves ancestry. A reused PID whose
        // creation is later than the child cannot be that child's parent.
        if (parent && before(parent, p)) ownership = classify(parent)
        else if (p.parent === this.snapshot.appPid) ownership = 'owned'
        else if (this.history.get(p.parent)?.some(g => g.ownership === 'owned' && before(g.process, p))) ownership = 'owned'
        // Missing or unreadable parent identity remains unknown: cancel handoff.
      }
      visiting.delete(p.pid); known.set(p.pid, ownership); return ownership
    }
    let busy = false
    for (const p of processes) {
      const ownership = classify(p)
      this.remember(p, ownership)
      let helper = p.pid === this.snapshot.appPid
      try { helper ||= ownership === 'owned' && !!p.path && windowsPath(p.path) === this.app } catch { /* ambiguous paths do not exempt a process */ }
      if (!helper && ownership !== 'unrelated') busy = true
    }
    return busy
  }
}
