import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { runsApi, type RunStatus, type StepStatus } from '../runs/api'
import { RunSteps, type RunStep } from '../runs/RunSteps'
import { missionsApi, TASK_STATUS_KEY, type MissionTaskDetail } from './api'
import { DiffView } from './DiffView'

interface LiveStep extends RunStep {
  commands?: string[]
  violations?: string[]
}

/** One task: its live steps, the commands, the violations and the diff. */
export function TaskView({
  missionId,
  taskKey,
  onError,
}: {
  missionId: number
  taskKey: string
  onError: (message: string) => void
}) {
  const { t } = useI18n()
  const [task, setTask] = useState<MissionTaskDetail | null>(null)
  const [steps, setSteps] = useState<LiveStep[]>([])
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null)
  const [diff, setDiff] = useState('')
  const [diffError, setDiffError] = useState<string | null>(null)
  const followRef = useRef<AbortController | null>(null)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    let alive = true
    setTask(null)
    setSteps([])
    setDiff('')
    setDiffError(null)
    void missionsApi
      .task(missionId, taskKey)
      .then((next) => alive && setTask(next))
      .catch((err) => alive && onErrorRef.current(err instanceof Error ? err.message : t('error.unexpected')))
    return () => {
      alive = false
    }
  }, [missionId, taskKey, t])

  // Follows the latest run from its first event: an old attempt stays readable below.
  useEffect(() => {
    if (!task?.runId) {
      setSteps(fromReport(task))
      return
    }
    followRef.current?.abort()
    const abort = new AbortController()
    followRef.current = abort
    setSteps([])
    const update = (change: (s: LiveStep) => LiveStep) =>
      setSteps((list) => {
        const at = list.findLastIndex((s) => s.current)
        const index = at >= 0 ? at : list.length - 1
        if (index < 0) return list
        return list.map((s, i) => (i === index ? change(s) : s))
      })
    const upsert = (id: string, agent: string, change: (s: LiveStep) => LiveStep) =>
      setSteps((list) =>
        list.some((s) => s.id === id)
          ? list.map((s) => (s.id === id ? change(s) : s))
          : [...list, change({ id, agent, status: 'pending', text: '', tools: [] })],
      )
    void (async () => {
      try {
        for await (const event of runsApi.follow(task.runId!, abort.signal)) {
          switch (event.type) {
            case 'step_started':
              upsert(event.id, event.agent, (s) => ({ ...s, status: 'running', current: true }))
              setSteps((list) => list.map((s) => ({ ...s, current: s.id === event.id })))
              break
            case 'iteration_started':
              upsert(event.id, event.agent, (s) => ({
                ...s,
                status: 'running',
                round: { n: event.iteration, max: event.max },
                text: s.text && `${s.text}\n\n— ${event.iteration}/${event.max} —\n\n`,
              }))
              setSteps((list) => list.map((s) => ({ ...s, current: s.id === event.id })))
              break
            case 'step_finished':
              upsert(event.id, '', (s) => ({ ...s, status: event.status as StepStatus }))
              break
            case 'text':
              update((s) => ({ ...s, text: s.text + event.text }))
              break
            case 'tool':
              update((s) => ({ ...s, tools: [...s.tools, event.name] }))
              break
            case 'check_output':
              update((s) => ({ ...s, text: s.text + event.text }))
              break
            case 'commands_finished':
              upsert(event.id, '', (s) => ({
                ...s,
                commands: event.results.map(
                  (r) => `${r.name}: ${r.ok ? 'ok' : 'no'} (exit ${r.exitCode ?? '?'}${r.timedOut ? ', timeout' : ''})`,
                ),
              }))
              break
            case 'protect_violation':
              upsert(event.id, '', (s) => ({
                ...s,
                violations: [...(s.violations ?? []), ...event.files.map((f) => `${t('missions.task.protected')}: ${f}`)],
              }))
              break
            case 'scope_violation':
              upsert(event.id, '', (s) => ({
                ...s,
                violations: [
                  ...(s.violations ?? []),
                  ...event.violations.map((v) => `${v.file}${v.name ? `: ${v.name}` : ''}`),
                ],
              }))
              break
            case 'finished':
              setRunStatus(event.status)
              break
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) onErrorRef.current(err instanceof Error ? err.message : t('error.unexpected'))
      }
    })()
    return () => abort.abort()
  }, [task?.runId, t])

  // The diff follows the attempt's end, when the branch has one commit.
  useEffect(() => {
    if (!task) return
    if (['pending', 'running', 'review', 'merging'].includes(task.status) && !task.report) return
    void missionsApi
      .taskDiff(missionId, taskKey)
      .then(setDiff)
      .catch((err) => setDiffError(err instanceof Error ? err.message : t('error.unexpected')))
  }, [missionId, taskKey, task?.status, task, t])

  useEffect(() => () => followRef.current?.abort(), [])

  if (!task) return <p className="hint">{t('missions.loading')}</p>

  return (
    <section className="card task-view">
      <header className="row">
        <h2>
          {task.key} · {task.title}
        </h2>
        <span className={`badge ${task.status === 'blocked' ? 'danger' : task.status === 'done' ? 'accent' : ''}`}>
          {t(TASK_STATUS_KEY[task.status])}
        </span>
        {runStatus && <span className="hint">run {task.runId} · {runStatus}</span>}
      </header>
      <p className="hint">
        {t('missions.task.attempt', { n: String(task.attempts + 1) })} · {t('missions.task.milestone', { id: task.milestone })}
      </p>

      {task.report?.blocked && (
        <p className="error" role="alert">
          {t('missions.task.blockedReason', { reason: task.report.blocked.reason })}: {task.report.blocked.detail}
        </p>
      )}
      {task.report?.warnings.map((warning) => (
        <p key={warning} className="hint">
          {warning}
        </p>
      ))}

      <RunSteps
        steps={steps}
        renderExtra={(s) => (
          <>
            {s.commands && (
              <ul className="commands">
                {s.commands.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {s.violations && (
              <ul className="error-list">
                {s.violations.map((line) => (
                  <li key={line} className="error">
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      />

      {task.report && (
        <section>
          <h3>{t('missions.task.report')}</h3>
          <p className="hint">
            {t('missions.task.diffStat', {
              added: String(task.report.diff?.added ?? 0),
              removed: String(task.report.diff?.removed ?? 0),
            })}
            {task.report.review && ` · ${task.report.review.verdict}`}
          </p>
          {task.report.review && <div className="bubble">{task.report.review.output}</div>}
          {task.report.previous && (
            <details>
              <summary>{t('missions.task.previous')}</summary>
              <p className="hint">{task.report.previous.review}</p>
              <DiffView diff={task.report.previous.diff} />
            </details>
          )}
        </section>
      )}

      <section>
        <h3>{t('missions.diff.title')}</h3>
        {diffError ? <p className="error">{diffError}</p> : <DiffView diff={diff} />}
      </section>

      {task.runs.length > 1 && (
        <details>
          <summary>{t('missions.task.attempts', { n: String(task.runs.length) })}</summary>
          {task.runs.slice(1).map((run) => (
            <details key={run.id}>
              <summary>
                run {run.id} · {run.status} · ${run.costUsd.toFixed(2)}
              </summary>
              <RunSteps
                steps={run.steps.map((s) => ({
                  id: s.id,
                  agent: s.agent,
                  status: s.status,
                  text: s.output,
                  tools: [],
                }))}
              />
            </details>
          ))}
        </details>
      )}
    </section>
  )
}

/** The last report as steps, for a task whose worktree is gone. */
function fromReport(task: MissionTaskDetail | null): LiveStep[] {
  if (!task?.report) return []
  const steps: LiveStep[] = []
  if (task.report.summary) {
    steps.push({
      id: 'task',
      agent: task.key,
      status: task.status === 'done' ? 'done' : 'failed',
      text: task.report.summary,
      tools: [],
    })
  }
  return steps
}
