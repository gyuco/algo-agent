import { useI18n } from '../i18n/useI18n'
import type { ActiveRunsState } from './useActiveRuns'

/** Header counter of runs and missions that need the user; opens the Activity page. */
export function ActivityBadge({
  state,
  missions = 0,
}: {
  state: ActiveRunsState
  missions?: number
}) {
  const { t } = useI18n()
  const { active, attention } = state
  const needYou = attention.length + missions
  if (active.length === 0 && needYou === 0) return null
  return (
    <a className="activity-status" href="#/activity">
      {active.length > 0 && (
        <span>
          <span className="dot busy" aria-hidden="true" /> {t('activity.badge', { count: String(active.length) })}
        </span>
      )}
      {needYou > 0 && (
        <span className="attention">{t('activity.badgeAttention', { count: String(needYou) })}</span>
      )}
    </a>
  )
}
