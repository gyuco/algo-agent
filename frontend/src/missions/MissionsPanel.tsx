import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { missionsApi, MISSION_STATUS_KEY, type Mission } from './api'
import { MissionForm } from './MissionForm'
import { MissionView } from './MissionView'

interface Props {
  projectId: number
  /** Mission to open from "Trasforma in missione"; cleared through `onOpened`. */
  initialMissionId?: number | null
  onOpened?: () => void
}

/** The Missions tab: new mission and the project's missions. */
export function MissionsPanel({ projectId, initialMissionId, onOpened }: Props) {
  const { t } = useI18n()
  const [missions, setMissions] = useState<Mission[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setMissions(await missionsApi.list({ projectId }))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (initialMissionId === null || initialMissionId === undefined) return
    setSelected(initialMissionId)
    onOpened?.()
  }, [initialMissionId, onOpened])

  if (selected !== null) {
    return (
      <MissionView
        missionId={selected}
        onBack={() => {
          setSelected(null)
          void load()
        }}
        onDeleted={() => {
          setSelected(null)
          void load()
        }}
      />
    )
  }

  return (
    <div className="missions">
      <div className="card">
        <header className="row spread">
          <h2>{t('missions.title')}</h2>
          <button type="button" onClick={() => setCreating((value) => !value)}>
            {t(creating ? 'missions.cancel' : 'missions.new')}
          </button>
        </header>
        {creating && (
          <MissionForm
            projectId={projectId}
            onCancel={() => setCreating(false)}
            onDone={(id) => {
              setCreating(false)
              setSelected(id)
              void load()
            }}
          />
        )}
        {!creating && <p className="hint">{t('missions.intro')}</p>}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="hint">{t('missions.loading')}</p>}
      {!loading && missions.length === 0 && <p className="hint">{t('missions.empty')}</p>}
      {missions.length > 0 && (
        <ul className="mission-list">
          {missions.map((mission) => (
            <li key={mission.id}>
              <button type="button" className="mission-row" onClick={() => setSelected(mission.id)}>
                <strong>{mission.title}</strong>
                <span className={`badge ${mission.status === 'approved' ? 'accent' : ''}`}>
                  {t(MISSION_STATUS_KEY[mission.status])}
                </span>
                <span className="hint">
                  {t('missions.row', {
                    mode: t(mission.mode === 'auto' ? 'missions.modeAuto' : 'missions.modeStep'),
                    n: String(mission.planVersion),
                  })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
