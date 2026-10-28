import { useI18n } from '../i18n/useI18n'
import type { ActiveRunsState } from './useActiveRuns'

/** Header counter of runs in progress and runs that need the user; opens the Activity page. */
export function ActivityBadge({ state }: { state: ActiveRunsState }) {
  const { t } = useI18n()
  const { active, attention } = state
  if (active.length === 0 && attention.length === 0) return null
  return (
    <a className="activity-status" href="#/activity">
      {active.length > 0 && (
        <span>
          <span className="dot busy" aria-hidden="true" /> {t('activity.badge', { count: String(active.length) })}
        </span>
      )}
      {attention.length > 0 && (
        <span className="attention">{t('activity.badgeAttention', { count: String(attention.length) })}</span>
      )}
    </a>
  )
}
