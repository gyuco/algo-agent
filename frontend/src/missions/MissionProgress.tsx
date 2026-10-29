import { useI18n } from '../i18n/useI18n'
import type { Mission } from './api'
import { HOLDER_KEY, missionStage, PHASE_KEY, PHASES } from './missionStage'
import { StatusIcon } from './StatusIcon'

/** The phases with the current one marked, then what happens now and who has to act. */
export function MissionProgress({ mission, onGo }: { mission: Mission; onGo?: () => void }) {
  const { t } = useI18n()
  const stage = missionStage(mission)
  const at = PHASES.indexOf(stage.phase)
  const finished = stage.holder === 'done'

  return (
    <div className="mission-progress">
      <ol className="mission-stepper">
        {PHASES.map((phase, i) => {
          const state = finished || i < at ? 'done' : i === at ? 'current' : 'todo'
          return (
            <li key={phase} className={`${state} ${state === 'current' ? stage.holder : ''}`}>
              <span className="mission-stepper-mark">{state === 'done' ? '✓' : i + 1}</span>
              <span className="mission-stepper-label">{t(PHASE_KEY[phase])}</span>
            </li>
          )
        })}
      </ol>
      <div className={`mission-now ${stage.holder}`} role="status">
        {stage.holder === 'agents' ? (
          <StatusIcon tone="running" />
        ) : (
          <StatusIcon
            tone={
              stage.holder === 'you' ? 'you' : stage.holder === 'done' ? 'done' : stage.holder === 'stopped' ? 'failed' : 'pending'
            }
          />
        )}
        <div className="mission-now-text">
          <strong>{t(HOLDER_KEY[stage.holder])}</strong>
          <span>{t(stage.message, stage.params)}</span>
        </div>
        {stage.holder === 'you' && onGo && (
          <button type="button" onClick={onGo}>
            {t('missions.now.go')}
          </button>
        )}
      </div>
    </div>
  )
}
