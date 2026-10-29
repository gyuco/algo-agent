import { useI18n } from '../i18n/useI18n'
import { TASK_STATUS_KEY, type Mission, type MissionTask } from './api'
import { TASK_TONE } from './missionStage'
import { StatusIcon } from './StatusIcon'

/** The plan's tasks by milestone, with their state; a row opens the task. */
export function TaskList({
  mission,
  selected,
  onSelect,
}: {
  mission: Mission
  selected: string | null
  onSelect: (key: string) => void
}) {
  const { t } = useI18n()
  const tasks = mission.tasks ?? []
  const byKey = new Map(tasks.map((task) => [task.key, task]))
  const milestones = mission.plan?.milestones ?? []
  const current = mission.status === 'done' ? undefined : mission.progress?.currentMilestone?.id
  const reviewed = new Set(mission.progress?.reviewedMilestones ?? [])

  // One line under the title, fixed by the state: the stream stays in the task view.
  const row = (task: MissionTask) => {
    const tone = TASK_TONE[task.status]
    const status = t(TASK_STATUS_KEY[task.status])
    const notes = [
      task.attempts > 0 && t('missions.task.attempt', { n: String(task.attempts + 1) }),
      task.waitingOn.length > 0 && t('missions.task.waits', { keys: task.waitingOn.join(', ') }),
    ].filter(Boolean)
    return (
      <li key={task.key}>
        <button
          type="button"
          className={`task-row ${tone} ${selected === task.key ? 'selected' : ''}`}
          aria-current={selected === task.key}
          onClick={() => onSelect(task.key)}
        >
          <StatusIcon tone={tone} label={status} />
          <span className="task-title">{task.title || task.key}</span>
          <span className={`task-status ${tone}`}>{status}</span>
          <small className="hint">
            <code>{task.key}</code>
            {notes.length > 0 && ` · ${notes.join(' · ')}`}
          </small>
        </button>
      </li>
    )
  }

  return (
    <div className="task-list">
      {milestones.map((milestone) => {
        const rows = milestone.tasks.map((task) => byKey.get(task.key)).filter((task): task is MissionTask => Boolean(task))
        if (!rows.length) return null
        const done = rows.filter((task) => task.status === 'done' || task.status === 'skipped').length
        return (
          <section
            key={milestone.id}
            className={`milestone ${current === milestone.id ? 'current' : ''}`}
          >
            <h3>
              <span>{milestone.title ?? milestone.id}</span>
              <span className="hint">
                {done}/{rows.length}
              </span>
              {current === milestone.id && (
                <span className="badge accent">{t('missions.milestone.current')}</span>
              )}
              {reviewed.has(milestone.id) && (
                <span className="badge">{t('missions.milestone.reviewed')}</span>
              )}
            </h3>
            <ul>{rows.map(row)}</ul>
          </section>
        )
      })}
      {tasks.length === 0 && <p className="hint">{t('missions.tasksEmpty')}</p>}
    </div>
  )
}
