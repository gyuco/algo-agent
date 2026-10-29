import { useI18n } from '../i18n/useI18n'
import { TASK_STATUS_KEY, type Mission, type MissionTask } from './api'

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
  const current = mission.progress?.currentMilestone?.id
  const reviewed = new Set(mission.progress?.reviewedMilestones ?? [])

  const row = (task: MissionTask) => {
    const blocked = task.status === 'blocked' ? task.report?.blocked : undefined
    return (
      <li key={task.key}>
        <button
          type="button"
          className={`task-row ${selected === task.key ? 'selected' : ''}`}
          onClick={() => onSelect(task.key)}
        >
          <span className={`badge ${task.status === 'blocked' ? 'danger' : task.status === 'done' ? 'accent' : ''}`}>
            {t(TASK_STATUS_KEY[task.status])}
          </span>
          <span className="task-key">{task.key}</span>
          <span className="task-title">{task.title}</span>
          <small className="hint">
            {t('missions.task.attempt', { n: String(task.attempts + 1) })}
            {task.waitingOn.length > 0 && ` · ${t('missions.task.waits', { keys: task.waitingOn.join(', ') })}`}
          </small>
          {blocked && <small className="error">{blocked.detail}</small>}
          {task.report?.summary && <small className="hint task-last">{task.report.summary.split('\n')[0]}</small>}
        </button>
      </li>
    )
  }

  return (
    <div className="task-list">
      {milestones.map((milestone) => {
        const rows = milestone.tasks.map((task) => byKey.get(task.key)).filter((task): task is MissionTask => Boolean(task))
        if (!rows.length) return null
        return (
          <section
            key={milestone.id}
            className={`milestone ${current === milestone.id ? 'current' : ''}`}
          >
            <h3>
              {milestone.title ?? milestone.id}
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
