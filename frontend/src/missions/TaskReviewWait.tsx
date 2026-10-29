import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { missionsApi, type Mission, type MissionTask } from './api'
import { DiffView } from './DiffView'

/** `task_review`: the report and the diff, then Ok or "Rifai con nota". */
export function TaskReviewWait({
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
  const [diff, setDiff] = useState('')
  const [busy, setBusy] = useState(false)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    void missionsApi
      .taskDiff(mission.id, task.key)
      .then(setDiff)
      .catch((err) => onErrorRef.current(err instanceof Error ? err.message : t('error.unexpected')))
  }, [mission.id, task.key, t])

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

  const report = task.report
  return (
    <section className="card task-wait">
      <h2>{t('missions.wait.reviewTitle', { key: task.key })}</h2>
      {report && (
        <>
          <p className="hint">
            {t('missions.task.diffStat', {
              added: String(report.diff?.added ?? 0),
              removed: String(report.diff?.removed ?? 0),
            })}
            {report.review && ` · ${report.review.verdict}`}
            {report.iterations > 0 && ` · ${t('missions.task.rounds', { n: String(report.iterations) })}`}
          </p>
          {report.warnings.map((warning) => (
            <p key={warning} className="hint">
              {warning}
            </p>
          ))}
          {report.summary && <div className="bubble">{report.summary}</div>}
        </>
      )}
      <DiffView diff={diff} />
      <label>
        {t('missions.wait.redoNote')}
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="row end">
        <button
          type="button"
          className="secondary"
          disabled={busy || !note.trim()}
          onClick={() => void act(() => missionsApi.taskRedo(mission.id, task.key, note.trim()))}
        >
          {t('missions.wait.redo')}
        </button>
        <button type="button" disabled={busy} onClick={() => void act(() => missionsApi.taskOk(mission.id, task.key))}>
          {t('missions.wait.ok')}
        </button>
      </div>
    </section>
  )
}
