import { useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { missionsApi, type Mission } from './api'

/** §5.7: the task left the perimeter; the user accepts, redoes with a note, or reviews the plan. */
export function ScopeWait({
  mission,
  onChanged,
  onError,
}: {
  mission: Mission
  onChanged: () => Promise<unknown>
  onError: (message: string) => void
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const task = mission.tasks?.find((row) => row.id === mission.wait?.taskId)
  const violations = mission.wait?.violations ?? task?.report?.violations ?? []
  const groups = violations.reduce<Record<string, string[]>>((all, violation) => {
    const label =
      violation.kind === 'dependency' ? t('missions.dependencies') : violation.kind
    all[label] = [...(all[label] ?? []), violation.name ?? violation.file]
    return all
  }, {})

  async function run(action: () => Promise<unknown>) {
    if (busy) return
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

  return (
    <section className="card">
      <h2>{t('missions.wait.scopeTitle', { key: task?.key ?? '—' })}</h2>
      <ul>
        {Object.entries(groups).map(([kind, files]) => (
          <li key={kind}>
            <strong>{kind}</strong>: {files.join(', ')}
          </li>
        ))}
      </ul>
      <div className="row end">
        <button
          type="button"
          className="secondary"
          onClick={() => document.getElementById('mission-input')?.focus()}
        >
          {t('missions.revise')}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || !task}
          onClick={() => {
            const note = window.prompt(t('missions.wait.redoNote'))
            if (note && task) void run(() => missionsApi.taskRedo(mission.id, task.key, note))
          }}
        >
          {t('missions.wait.redo')}
        </button>
        <button type="button" disabled={busy} onClick={() => void run(() => missionsApi.acceptScope(mission.id))}>
          {t('missions.wait.scopeAccept')}
        </button>
      </div>
    </section>
  )
}
