import { useCallback, useEffect, useState } from 'react'
import { claudeApi, type ClaudeStatus, type RateLimitSnapshot } from './api'

export type RunAction = (action: () => Promise<ClaudeStatus | void>) => Promise<void>

export function useClaudeStatus() {
  const [status, setStatus] = useState<ClaudeStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    () =>
      claudeApi
        .status()
        .then(setStatus)
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : 'Verifica non riuscita'),
        )
        .finally(() => setChecking(false)),
    [],
  )

  useEffect(() => {
    void load()
  }, [load])

  const reload = useCallback(() => {
    setChecking(true)
    return load()
  }, [load])

  /** Runs an action; a returned status replaces the current one. */
  const run = useCallback<RunAction>(async (action) => {
    setBusy(true)
    setError(null)
    try {
      const next = await action()
      if (next) setStatus(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operazione non riuscita')
    } finally {
      setBusy(false)
    }
  }, [])

  /** Applies plan usage reported elsewhere (e.g. by a chat turn) without refetching. */
  const updateRateLimits = useCallback((rateLimits: RateLimitSnapshot) => {
    setStatus((current) =>
      current?.session ? { ...current, session: { ...current.session, rateLimits } } : current,
    )
  }, [])

  return { status, checking, busy, error, run, reload, updateRateLimits }
}

export type ClaudeStatusState = ReturnType<typeof useClaudeStatus>
