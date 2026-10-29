import { useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { MISSION_STATUS_KEY, missionsApi } from './api'
import { BaselineWait } from './BaselineWait'
import { BriefingView } from './BriefingView'
import { PlanView } from './PlanView'
import { PreparationView } from './PreparationView'
import { useMissionEvents } from './useMissionEvents'

interface Props {
  missionId: number
  onBack: () => void
  onDeleted: () => void
}

/** One mission: the briefing on the left, the plan or what is running on the right. */
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

  const setError = (message: string) => setActionError(message)

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

  const baseline = mission.status === 'waiting' && mission.wait?.code === 'baseline'

  return (
    <div className="mission-view">
      <header className="mission-header">
        <button type="button" className="secondary" onClick={onBack}>
          ← {t('missions.back')}
        </button>
        <h1 className="workspace-title">{mission.title}</h1>
        <span className={`badge ${mission.status !== 'briefing' ? 'accent' : ''}`}>
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
        <div className="mission-right">
          {mission.status === 'planned' && (
            <PlanView mission={mission} onChanged={refresh} />
          )}
          {mission.status === 'approved' && (
            <PreparationView mission={mission} onChanged={refresh} onError={setError} />
          )}
          {baseline && (
            <BaselineWait
              mission={mission}
              entries={entries}
              onChanged={refresh}
              onError={setError}
            />
          )}
          {mission.status === 'running' && (
            <section className="card mission-ready">
              <h2>{t('missions.ready')}</h2>
              <dl className="plan-facts">
                <dt>{t('missions.branch')}</dt>
                <dd>
                  <code>{mission.branch ?? '—'}</code>
                </dd>
                <dt>{t('missions.worktree')}</dt>
                <dd>
                  <code>{mission.worktreePath ?? '—'}</code>
                </dd>
                <dt>{t('missions.baseCommit')}</dt>
                <dd>
                  <code>{mission.baseCommit?.slice(0, 12) ?? '—'}</code>
                </dd>
              </dl>
              <p className="hint">{t('missions.readyHint')}</p>
            </section>
          )}
          {mission.status === 'waiting' && !baseline && (
            <section className="card">
              <h2>{t('missions.waiting')}</h2>
              <p className="hint">{mission.wait?.code ?? '—'}</p>
            </section>
          )}
          {mission.status === 'aborted' && (
            <section className="card">
              <p className="hint">{t('missions.abortedHint')}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
