import { useI18n } from '../i18n/useI18n'
import type { Mission, MissionEntry } from './api'

/** §5.6: the orchestrator is reviewing the plan; its log is shown live. */
export function RevisionPanel({
  mission,
  entries,
}: {
  mission: Mission
  entries: MissionEntry[]
}) {
  const { t } = useI18n()
  const recent = entries
    .filter((entry) => ['turn', 'decision', 'plan', 'note', 'error'].includes(entry.kind))
    .slice(-8)
  return (
    <section className="card">
      <h2>{t('missions.wait.revisionTitle')}</h2>
      <p className="hint">{t('missions.wait.revisionHint')}</p>
      <ul className="mission-log">
        {recent.map((entry) => {
          const data = entry.data as {
            text?: string
            question?: string
            reason?: string
            message?: string
            chosen?: string
          }
          return (
            <li key={entry.id}>
              <small className="hint">{entry.kind}</small>{' '}
              {data.text ?? data.question ?? data.reason ?? data.message ?? data.chosen ?? ''}
            </li>
          )
        })}
      </ul>
      <p className="hint">{t('missions.commentPlaceholder')}</p>
      <a className="button secondary" href={mission.projectId === null ? '#/activity' : `#/workspace/${mission.projectId}/mission/${mission.id}`}>
        {t('missions.briefing')}
      </a>
    </section>
  )
}
