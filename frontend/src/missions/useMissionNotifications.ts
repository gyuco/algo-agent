import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { missionsApi, type MissionEntry } from './api'
import { notificationText } from './notifications'

/**
 * §7.2: one stream of the user's missions, mounted once in App. Notifies the
 * entries that ask, keeps the unread count, and opens the mission on click.
 */
export function useMissionNotifications(enabled: boolean) {
  const { t } = useI18n()
  // Mission ids, not entries: one mission with many entries counts once.
  const [unread, setUnread] = useState<ReadonlySet<number>>(new Set())
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  )
  const missions = useRef(new Map<number, { title: string; projectId: number | null }>())

  const refresh = () => {
    void missionsApi
      .list()
      .then((list) => {
        missions.current = new Map(
          list.map((mission) => [
            mission.id,
            { title: mission.title, projectId: mission.projectId },
          ]),
        )
      })
      .catch(() => undefined)
    void missionsApi
      .list({ unread: true })
      .then((list) => setUnread(new Set(list.map((mission) => mission.id))))
      .catch(() => undefined)
  }

  useEffect(() => {
    if (!enabled) return
    refresh()
    const timer = setInterval(refresh, 30_000)
    const controller = new AbortController()
    const notify = (entry: MissionEntry) => {
      setUnread((ids) =>
        ids.has(entry.missionId) ? ids : new Set(ids).add(entry.missionId),
      )
      if (!entry.notify) return
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      if (document.visibilityState === 'visible') return
      const mission = missions.current.get(entry.missionId)
      if (!mission) return
      const notification = new Notification(
        t('missions.notify.title', { title: mission.title }),
        {
          body: notificationText(entry, t),
          tag: `mission-${entry.missionId}`,
        },
      )
      notification.onclick = () => {
        window.focus()
        window.location.hash =
          mission.projectId === null
            ? '#/activity'
            : `#/workspace/${mission.projectId}/mission/${entry.missionId}`
        notification.close()
      }
    }
    void (async () => {
      try {
        for await (const entry of missionsApi.activeEvents(controller.signal)) {
          notify(entry)
        }
      } catch {
        // The stream reconnects on its own; closing the tab stops it.
      }
    })()
    return () => {
      controller.abort()
      clearInterval(timer)
    }
    // `t` and the language: a notification is written in the current one.
  }, [enabled, t])

  const request = () => {
    if (typeof Notification === 'undefined') return
    void Notification.requestPermission().then(setPermission)
  }

  return { unread: unread.size, permission, request }
}
