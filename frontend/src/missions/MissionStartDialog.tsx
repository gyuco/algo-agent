import { useI18n } from '../i18n/useI18n'
import { MissionForm } from './MissionForm'

interface Props {
  projectId: number
  fromSession: string
  onClose: () => void
  onCreated: (missionId: number) => void
}

/** "Trasforma in missione": the conversation becomes the start of the briefing. */
export function MissionStartDialog({ projectId, fromSession, onClose, onCreated }: Props) {
  const { t } = useI18n()
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="card modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('missions.transform')}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="row spread">
          <h2>{t('missions.transform')}</h2>
          <button type="button" className="icon" aria-label={t('missions.cancel')} onClick={onClose}>
            ×
          </button>
        </header>
        <MissionForm
          projectId={projectId}
          fromSession={fromSession}
          onDone={onCreated}
          onCancel={onClose}
        />
      </div>
    </div>
  )
}
