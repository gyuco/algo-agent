import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { connectionsApi, type ConnectionStatus } from './api'

export type RunAction = (action: () => Promise<ConnectionStatus | void>) => Promise<void>

/** Every provider's connection, loaded once signed in and updated by the actions run through it. */
export function useConnections(enabled: boolean) {
  const { t } = useI18n()
  const [connections, setConnections] = useState<ConnectionStatus[]>([])
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    () =>
      connectionsApi
        .list()
        .then(setConnections)
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : t('verify.failed')),
        )
        .finally(() => setChecking(false)),
    [t],
  )

  useEffect(() => {
    if (!enabled) {
      setConnections([])
      setError(null)
      setChecking(true)
      return
    }
    void load()
  }, [enabled, load])

  const reload = useCallback(() => {
    setChecking(true)
    return load()
  }, [load])

  /** Runs an action; a returned status replaces that provider's. */
  const run = useCallback<RunAction>(
    async (action) => {
      setBusy(true)
      setError(null)
      try {
        const next = await action()
        if (next) {
          setConnections((list) => list.map((c) => (c.provider === next.provider ? next : c)))
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('operation.failed'))
      } finally {
        setBusy(false)
      }
    },
    [t],
  )

  /** Applies details a provider reported elsewhere (e.g. plan usage in a chat turn) without refetching. */
  const updateDetails = useCallback((provider: string, details: Record<string, unknown>) => {
    setConnections((list) =>
      list.map((c) => (c.provider === provider ? { ...c, details: { ...c.details, ...details } } : c)),
    )
  }, [])

  return {
    connections,
    connected: connections.filter((c) => c.connected),
    checking,
    busy,
    error,
    run,
    reload,
    updateDetails,
  }
}

export type ConnectionsState = ReturnType<typeof useConnections>
