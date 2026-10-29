import { useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { MISSION_STATUS_KEY, missionsApi } from './api'
import { BriefingView } from './BriefingView'
import { PlanView } from './PlanView'
import { useMissionEvents } from './useMissionEvents'

interface Props {
  missionId: number
  onBack: () => void
  onDeleted: () => void
}

/** One mission: the briefing on the left, the plan on the right. */
export function MissionView({ missionId, onBack, onDeleted }: Props) {
  const { t } = useI18n()
  const { mission, entries, error, loading, refresh } = useMissionEvents(missionId)
  const [actionError, setActionError] = useState<string | null>(null)

  async function abort() {
    if (!mission) return
    if (!window.confirm(t('missions.abortConfirm'))) return
    setActionError(null)
    try {
      await missionsApi.abort(mission.id)
      await refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('error.unexpected'))
    }
  }

  async function remove() {
    if (!mission) return
    if (!window.confirm(t('missions.deleteConfirm'))) return
    setActionError(null)
    try {
      await missionsApi.remove(mission.id)
      onDeleted()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('error.unexpected'))
    }
  }

  if (error) {
    return (
      <div className="card">
        <p className="error" role="alert">
          {error}
        </p>
        <button type="button" className="secondary" onClick={onBack}>
          {t('missions.back')}
        </button>
      </div>
    )
  }
  if (loading || !mission) return <p className="hint">{t('missions.loading')}</p>

  return (
    <div className="mission-view">
      <header className="mission-header">
        <button type="button" className="secondary" onClick={onBack}>
          ← {t('missions.back')}
        </button>
        <h1 className="workspace-title">{mission.title}</h1>
        <span className={`badge ${mission.status === 'approved' ? 'accent' : ''}`}>
          {t(MISSION_STATUS_KEY[mission.status])}
        </span>
        <span className="hint">{t('missions.planVersionShort', { n: String(mission.planVersion) })}</span>
        <div className="row">
          {mission.status !== 'aborted' && (
            <button type="button" className="danger" onClick={() => void abort()}>
              {t('missions.abort')}
            </button>
          )}
          {(mission.status === 'approved' || mission.status === 'aborted') && (
            <button type="button" className="secondary" onClick={() => void remove()}>
              {t('missions.delete')}
            </button>
          )}
        </div>
      </header>
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      <div className="mission-columns">
        <BriefingView mission={mission} entries={entries} onChanged={refresh} />
        <PlanView mission={mission} onChanged={refresh} />
      </div>
    </div>
  )
}
