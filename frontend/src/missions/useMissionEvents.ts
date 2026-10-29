import { useCallback, useEffect, useState } from 'react'
import { missionsApi, type Mission, type MissionEntry } from './api'

/** A mission kept current by its log stream, with the entries received so far. */
export function useMissionEvents(missionId: number) {
  const [mission, setMission] = useState<Mission | null>(null)
  const [entries, setEntries] = useState<MissionEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const next = await missionsApi.get(missionId)
    setMission(next)
    return next
  }, [missionId])

  useEffect(() => {
    const abort = new AbortController()
    let cursor = 0
    setMission(null)
    setEntries([])
    setError(null)
    setLoading(true)
    void (async () => {
      try {
        const [first, log] = await Promise.all([
          missionsApi.get(missionId),
          missionsApi.entries(missionId),
        ])
        if (abort.signal.aborted) return
        setMission(first)
        setEntries(log)
        cursor = log.at(-1)?.id ?? 0
        setLoading(false)
        for await (const entry of missionsApi.events(missionId, abort.signal, cursor)) {
          cursor = Math.max(cursor, entry.id)
          setEntries((list) =>
            list.some((e) => e.id === entry.id) ? list : [...list, entry],
          )
          const next = await missionsApi.get(missionId).catch(() => null)
          if (next && !abort.signal.aborted) setMission(next)
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          setError(err instanceof Error ? err.message : '')
          setLoading(false)
        }
      }
    })()
    return () => abort.abort()
  }, [missionId])

  return { mission, entries, error, loading, refresh, setMission }
}
