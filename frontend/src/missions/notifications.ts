import type { MessageKey } from '../i18n/messages'
import type { MissionEntry } from './api'

type Translate = (key: MessageKey, vars?: Record<string, string>) => string

/** The body of a system notification for one entry of the mission log (§7.2). */
export function notificationText(entry: MissionEntry, t: Translate) {
  const data = entry.data as {
    code?: string
    taskId?: number
    taskKey?: string
    id?: string
    detail?: string
    message?: string
    url?: string
  }
  const task = data.taskKey ? ` ${data.taskKey}` : ''
  switch (entry.kind) {
    case 'wait':
      if (data.code === 'task_review') return t('activity.missionReview', { key: data.taskKey ?? '—' })
      if (data.code === 'task_blocked') return t('activity.missionBlocked', { key: data.taskKey ?? '—' })
      if (data.code === 'scope') return t('missions.wait.scopeTitle', { key: data.taskKey ?? '—' })
      if (data.code === 'milestone') return t('missions.wait.milestoneTitle')
      if (data.code === 'final_checks') return t('activity.missionFinal')
      if (data.code === 'weekly_budget') return t('missions.wait.weeklyTitle')
      if (data.code === 'usd_budget') return t('missions.wait.usdTitle')
      if (data.code === 'five_hour' || data.code === 'model_window') return t('missions.wait.pausedTitle')
      if (data.code === 'publish') return t('missions.wait.publishTitle')
      return data.code ?? entry.kind
    case 'plan':
      return t('missions.planUpdated')
    case 'milestone':
      return t('missions.milestoneClosed', { id: data.id ?? '—' })
    case 'pr':
      return t('missions.prOpened')
    case 'resume':
      return t('missions.resumed')
    case 'final':
      return t('missions.done.title')
    case 'error':
      return data.message ?? data.detail ?? entry.kind
    case 'checks':
      return (entry.data as { ok?: boolean }).ok === false
        ? t('missions.wait.finalTitle')
        : entry.kind
    default:
      return `${entry.kind}${task}`
  }
}
