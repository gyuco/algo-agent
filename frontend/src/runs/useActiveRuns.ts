import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageKey } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import { isActive, runsApi, type Run, type RunStatus } from './api'

export const STATUS_KEY: Record<RunStatus, MessageKey> = {
  queued: 'status.queued',
  running: 'status.running',
  waiting: 'status.waiting',
  done: 'status.done',
  failed: 'status.failed',
  aborted: 'status.aborted',
  interrupted: 'status.interrupted',
}

/** Where a run is shown in its project: the chat or the workflows tab picks it up. */
export const runLink = (run: Pick<Run, 'id' | 'projectId'>) => `#/workspace/${run.projectId}/run/${run.id}`

/** The run needs the user: waiting for an answer, or ended badly and not looked at yet. */
export const needsUser = (run: Run) =>
  run.status === 'waiting' || (run.unread && (run.status === 'failed' || run.status === 'interrupted'))

function upsert(list: Run[], run: Run) {
  const rest = list.filter((r) => r.id !== run.id)
  return [run, ...rest].sort((a, b) => b.id - a.id)
}

/**
 * The user's runs in all projects, kept current by the server's activity
 * stream: the header counter, the Activity page and the panels read it.
 * Notifies the browser when a run ends while the tab is in the background.
 */
export function useActiveRuns(enabled: boolean) {
  const { t } = useI18n()
  const [runs, setRuns] = useState<Run[]>([])
  const [loaded, setLoaded] = useState(false)
  /** Current list for callbacks that run outside render. */
  const runsRef = useRef(runs)
  useEffect(() => {
    runsRef.current = runs
  }, [runs])

  const notifyEnd = useCallback(
    (before: Run | undefined, run: Run) => {
      if (!before || !isActive(before.status)) return
      if (isActive(run.status) && run.status !== 'waiting') return
      if (!document.hidden || typeof Notification === 'undefined') return
      if (Notification.permission !== 'granted') return
      const notification = new Notification(
        t('activity.notification', { title: run.title || t('sessions.untitled'), status: t(STATUS_KEY[run.status]) }),
        { body: run.projectName ?? undefined, tag: `run-${run.id}` },
      )
      notification.onclick = () => {
        window.focus()
        window.location.hash = runLink(run)
      }
    },
    [t],
  )

  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    void (async () => {
      for await (const notice of runsApi.watch(abort.signal)) {
        if (notice.type === 'ready') {
          runsApi.active().then(
            (list) => {
              if (abort.signal.aborted) return
              setRuns(list)
              setLoaded(true)
            },
            () => setLoaded(true),
          )
        } else if (notice.type === 'run') {
          notifyEnd(
            runsRef.current.find((r) => r.id === notice.run.id),
            notice.run,
          )
          setRuns((list) => upsert(list, notice.run))
        } else {
          setRuns((list) => list.map((r) => (r.id === notice.runId ? { ...r, activity: notice.activity } : r)))
        }
      }
    })().catch(() => undefined)
    return () => abort.abort()
  }, [enabled, notifyEnd])

  /** Marks a run as seen here at once; the server confirms through the stream. */
  const markSeen = useCallback((id: number) => {
    const run = runsRef.current.find((r) => r.id === id)
    if (run && !run.unread) return
    setRuns((list) => list.map((r) => (r.id === id ? { ...r, unread: false } : r)))
    void runsApi.seen(id).catch(() => undefined)
  }, [])

  const active = runs.filter((r) => isActive(r.status))
  return {
    runs,
    loaded,
    active,
    attention: runs.filter(needsUser),
    find: useCallback((id: number) => runs.find((r) => r.id === id), [runs]),
    markSeen,
  }
}

export type ActiveRunsState = ReturnType<typeof useActiveRuns>
