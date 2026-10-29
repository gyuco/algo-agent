import { useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { missionsApi, type Mission, type MissionTask } from './api'

/** `task_blocked`: why it stopped, then "Rifai con nota" or "Salta". */
export function TaskBlockedWait({
  mission,
  task,
  onChanged,
  onError,
}: {
  mission: Mission
  task: MissionTask
  onChanged: () => Promise<unknown>
  onError: (message: string) => void
}) {
  const { t } = useI18n()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function act(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
      await onChanged()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('error.unexpected'))
    } finally {
      setBusy(false)
    }
  }

  const blocked = task.report?.blocked
  return (
    <section className="card task-wait">
      <h2>{t('missions.wait.blockedTitle', { key: task.key })}</h2>
      {blocked && (
        <p className="error" role="alert">
          {t('missions.task.blockedReason', { reason: blocked.reason })}: {blocked.detail}
        </p>
      )}
      {task.report?.review && (
        <>
          <p className="hint">{t('missions.wait.lastReview')}</p>
          <div className="bubble">{task.report.review.output}</div>
        </>
      )}
      {task.report?.warnings.map((warning) => (
        <p key={warning} className="hint">
          {warning}
        </p>
      ))}
      <label>
        {t('missions.wait.redoNote')}
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="row end">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void act(() => missionsApi.taskSkip(mission.id, task.key))}
        >
          {t('missions.wait.skip')}
        </button>
        <button
          type="button"
          disabled={busy || !note.trim()}
          onClick={() => void act(() => missionsApi.taskRedo(mission.id, task.key, note.trim()))}
        >
          {t('missions.wait.redo')}
        </button>
      </div>
    </section>
  )
}
