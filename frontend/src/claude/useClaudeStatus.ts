import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { claudeApi, type ClaudeStatus, type RateLimitSnapshot } from './api'

export type RunAction = (action: () => Promise<ClaudeStatus | void>) => Promise<void>

export function useClaudeStatus() {
  const { t } = useI18n()
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
          setError(err instanceof Error ? err.message : t('verify.failed')),
        )
        .finally(() => setChecking(false)),
    [t],
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
      setError(err instanceof Error ? err.message : t('operation.failed'))
    } finally {
      setBusy(false)
    }
  }, [t])

  /** Applies plan usage reported elsewhere (e.g. by a chat turn) without refetching. */
  const updateRateLimits = useCallback((rateLimits: RateLimitSnapshot) => {
    setStatus((current) =>
      current?.session ? { ...current, session: { ...current.session, rateLimits } } : current,
    )
  }, [])

  return { status, checking, busy, error, run, reload, updateRateLimits }
}

export type ClaudeStatusState = ReturnType<typeof useClaudeStatus>
