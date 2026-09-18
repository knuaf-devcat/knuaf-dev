import { useCallback, useEffect, useRef, useState } from 'react'
import { describeError, rpc, RpcFailure } from '../rpc'
import type { Envelope, RpcResult } from '../../../shared/types'

export type RunnerLine = { stream: string; line: string }
export type RunnerPhase = { phase: string; [k: string]: unknown }

const LINE_CAP = 400

export interface Runner {
  busy: boolean
  lines: RunnerLine[]
  env: Envelope | null
  err: string | null
  cancelled: boolean
  phase: RunnerPhase | null
  elapsedMs: number
  clientId: string | null
  /** Run a script-backed sidecar method; resolves to the Envelope (or null when it failed/was cancelled). */
  run: (method: string, params: Record<string, unknown>) => Promise<Envelope | null>
  /** Run `deps.ensure` through main (wheelhouse-aware); resolves to the Envelope or null. */
  runDeps: (root: string) => Promise<Envelope | null>
  cancel: () => Promise<void>
  reset: () => void
}

/**
 * State for one long-running sidecar call at a time: live log, progress phase,
 * elapsed timer, cancel. A fresh clientId is minted per run so cancel targets
 * exactly that call.
 */
export function useRunner(): Runner {
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<RunnerLine[]>([])
  const [env, setEnv] = useState<Envelope | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const [phase, setPhase] = useState<RunnerPhase | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [clientId, setClientId] = useState<string | null>(null)
  const clientRef = useRef<string | null>(null)
  const startedAt = useRef<number>(0)

  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setElapsedMs(Date.now() - startedAt.current), 250)
    return () => clearInterval(t)
  }, [busy])

  const onEvent = useCallback((event: string, data: unknown) => {
    if (event === 'log') setLines((l) => [...l.slice(-(LINE_CAP - 1)), data as RunnerLine])
    else if (event === 'progress') setPhase(data as RunnerPhase)
  }, [])

  const begin = useCallback(() => {
    const id = rpc.newClientId()
    clientRef.current = id
    startedAt.current = Date.now()
    setClientId(id); setBusy(true); setLines([]); setEnv(null); setErr(null); setCancelled(false); setPhase(null); setElapsedMs(0)
    return id
  }, [])

  const finish = useCallback((id: string) => {
    if (clientRef.current === id) clientRef.current = null
    setElapsedMs(Date.now() - startedAt.current)
    setBusy(false)
  }, [])

  const fail = useCallback((e: unknown) => {
    if (e instanceof RpcFailure && e.code === 'cancelled') setCancelled(true)
    else setErr(describeError(e))
  }, [])

  const run = useCallback(async (method: string, params: Record<string, unknown>) => {
    const id = begin()
    try {
      const result = await rpc.script(method, params, onEvent, id)
      setEnv(result)
      return result
    } catch (e) { fail(e); return null } finally { finish(id) }
  }, [begin, finish, fail, onEvent])

  const runDeps = useCallback(async (root: string) => {
    const id = begin()
    try {
      const r: RpcResult<Envelope> = await window.knuaf.depsEnsure(root, onEvent, id)
      if (r.error) throw new RpcFailure(r.error)
      const result = r.result as Envelope
      setEnv(result)
      return result
    } catch (e) { fail(e); return null } finally { finish(id) }
  }, [begin, finish, fail, onEvent])

  const cancel = useCallback(async () => {
    const id = clientRef.current
    if (!id) return
    await rpc.cancel(id)
  }, [])

  const reset = useCallback(() => {
    if (clientRef.current) return // never wipe a run that is still in flight
    setLines([]); setEnv(null); setErr(null); setCancelled(false); setPhase(null); setElapsedMs(0); setClientId(null)
  }, [])

  return { busy, lines, env, err, cancelled, phase, elapsedMs, clientId, run, runDeps, cancel, reset }
}
