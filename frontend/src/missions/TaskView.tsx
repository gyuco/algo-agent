import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MessageText } from '../chat/MessageText'
import { useI18n } from '../i18n/useI18n'
import { runsApi, type RunStatus, type StepStatus } from '../runs/api'
import type { RunStep } from '../runs/RunSteps'
import { missionsApi, TASK_STATUS_KEY, type MissionTaskDetail, type TaskStatus } from './api'
import { DiffView } from './DiffView'
import { TASK_TONE, type TaskTone } from './missionStage'
import { StatusIcon } from './StatusIcon'

interface LiveStep extends RunStep {
  commands?: string[]
  violations?: string[]
}

/** One task: its live steps, the commands, the violations and the diff. */
export function TaskView({
  missionId,
  taskKey,
  status,
  compact = false,
  onError,
}: {
  missionId: number
  taskKey: string
  /** The state the mission reports: the task is read again when it changes. */
  status?: TaskStatus
  /** The task's wait card already shows the outcome and the diff: only the log stays. */
  compact?: boolean
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
    setTask(null)
    setSteps([])
    setDiff('')
    setDiffError(null)
    setRunStatus(null)
  }, [missionId, taskKey])

  // Read again on each state change, without blanking what is on screen.
  useEffect(() => {
    let alive = true
    void missionsApi
      .task(missionId, taskKey)
      .then((next) => alive && setTask(next))
      .catch((err) => alive && onErrorRef.current(err instanceof Error ? err.message : t('error.unexpected')))
    return () => {
      alive = false
    }
  }, [missionId, taskKey, status, t])

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

  const tone = TASK_TONE[task.status]
  const statusLabel = t(TASK_STATUS_KEY[task.status])
  // Working: the live steps lead. Settled: the outcome leads, the log folds away.
  const live = task.status === 'running' || task.status === 'merging'
  const report = task.report

  return (
    <section className={`card task-view ${tone}`}>
      <header className="task-view-head">
        <StatusIcon tone={tone} />
        <div className="task-view-title">
          <h2>{task.title || task.key}</h2>
          <small className="hint">
            <code>{task.key}</code> · {t('missions.task.attempt', { n: String(task.attempts + 1) })} ·{' '}
            {t('missions.task.milestone', { id: task.milestone })}
          </small>
        </div>
        <span className={`task-status ${tone}`}>{statusLabel}</span>
      </header>

      {report?.blocked && (
        <p className="error" role="alert">
          {t('missions.task.blockedReason', { reason: report.blocked.reason })}: {report.blocked.detail}
        </p>
      )}
      {report?.warnings.map((warning) => (
        <p key={warning} className="hint">
          {warning}
        </p>
      ))}

      {task.status === 'pending' && !steps.length && <p className="hint">{t('missions.task.notStarted')}</p>}
      {live && !steps.length && (
        <p className="hint task-starting">
          <StatusIcon tone="running" /> {t('missions.task.starting')}
        </p>
      )}
      {live && <StepTimeline steps={steps} />}

      {!live && !compact && report && (
        <section className="task-outcome">
          <h3>{t('missions.task.outcome')}</h3>
          <p className="hint">
            {t('missions.task.diffStat', {
              added: String(report.diff?.added ?? 0),
              removed: String(report.diff?.removed ?? 0),
            })}
            {report.iterations > 0 && ` · ${t('missions.task.rounds', { n: String(report.iterations) })}`}
            {report.review && ` · ${t('missions.task.verdict', { verdict: report.review.verdict })}`}
          </p>
          {report.summary && <MessageText text={report.summary} />}
          {report.review && (
            <details>
              <summary>{t('missions.wait.lastReview')}</summary>
              <MessageText text={report.review.output} />
            </details>
          )}
        </section>
      )}

      {!live && !compact && (diff || diffError) && (
        <details className="task-diff" open={task.status === 'review'}>
          <summary>
            {t('missions.diff.title')}
            {report?.diff && ` · ${report.diff.files.length} file`}
          </summary>
          {diffError ? <p className="error">{diffError}</p> : <DiffView diff={diff} />}
        </details>
      )}

      {!live && steps.length > 0 && (
        <details>
          <summary>{t('missions.task.log')}</summary>
          <StepTimeline steps={steps} />
        </details>
      )}

      {report?.previous && (
        <details>
          <summary>{t('missions.task.previous')}</summary>
          <p className="hint">{report.previous.review}</p>
          <DiffView diff={report.previous.diff} />
        </details>
      )}

      {task.runs.length > 1 && (
        <details>
          <summary>{t('missions.task.attempts', { n: String(task.runs.length - 1) })}</summary>
          {task.runs.slice(1).map((run) => (
            <details key={run.id}>
              <summary>
                run {run.id} · {run.status} · ${run.costUsd.toFixed(2)}
              </summary>
              <StepTimeline
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
      {runStatus && (
        <small className="hint">
          run {task.runId} · {runStatus}
        </small>
      )}
    </section>
  )
}

const STEP_TONE: Record<StepStatus, TaskTone> = {
  pending: 'pending',
  waiting_approval: 'you',
  running: 'running',
  done: 'done',
  skipped: 'skipped',
  failed: 'failed',
  aborted: 'failed',
}

/** The tools a step used, grouped: "read ×12 · edit ×3" instead of one chip per call. */
function toolSummary(tools: string[]) {
  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(' · ')
}

/** The steps of an attempt: state, round, grouped tools; the running one streams in a bounded box. */
function StepTimeline({ steps }: { steps: LiveStep[] }) {
  const { t } = useI18n()
  return (
    <ol className="task-steps">
      {steps.map((s, i) => {
        const tone = STEP_TONE[s.status]
        return (
          <li key={i} className={`task-step ${tone}`}>
            <div className="task-step-head">
              <StatusIcon tone={tone} />
              <strong>{s.id}</strong>
              <span className="hint">{s.agent}</span>
              {s.round && (
                <span className="hint">
                  · {t('workflows.round', { n: String(s.round.n), max: String(s.round.max) })}
                </span>
              )}
            </div>
            {s.tools.length > 0 && (
              <p className="hint task-step-tools">
                {t('missions.task.actions', { n: String(s.tools.length) })}: {toolSummary(s.tools)}
              </p>
            )}
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
            {s.text &&
              (s.status === 'running' ? (
                <LiveLog text={s.text} />
              ) : (
                <details>
                  <summary>{t('missions.output')}</summary>
                  <LiveLog text={s.text} />
                </details>
              ))}
            {s.error && (
              <p className="error" role="alert">
                {s.error}
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/** Streamed text in a fixed-height box that follows the end unless the user scrolled up. */
function LiveLog({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    const box = ref.current
    if (box && stick.current) box.scrollTop = box.scrollHeight
  }, [text])
  return (
    <div
      ref={ref}
      className="live-log"
      onScroll={(e) => {
        const box = e.currentTarget
        stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24
      }}
    >
      {text}
    </div>
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
