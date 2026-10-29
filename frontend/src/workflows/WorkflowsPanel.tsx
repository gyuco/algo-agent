import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { WorkflowResource } from '../agents/api'
import { LOCALES } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import { isActive, runsApi, type Run, type RunStatus, type StepStatus } from '../runs/api'
import { reasonText } from '../runs/reason'
import { RunSteps } from '../runs/RunSteps'
import { STATUS_KEY, type ActiveRunsState } from '../runs/useActiveRuns'
import { workflowsApi, type WorkflowRun } from './api'

interface LiveStep {
  id: string
  agent: string
  status: StepStatus
  text: string
  tools: string[]
  error?: string
  /** While it waits for approval: the prompt it will run and whether it may write files. */
  approval?: { prompt: string; writes: boolean }
  /** The step that text and tools go to: the last one started, or a repeat's step or check. */
  current?: boolean
  round?: { n: number; max: number }
}

interface Props {
  projectId: number
  /** Workflows switched on in the project. */
  workflows: WorkflowResource[]
  /** Provider details a turn reported, e.g. Claude's plan usage. */
  onUsage: (provider: string, details: Record<string, unknown>) => void
  /** The user's runs, kept live: status and wait reason of the one followed. */
  runs: ActiveRunsState
  /** Run to show, from a link. */
  open: Run | null
}

/**
 * Starts a workflow and follows its steps live; runs go on in the background,
 * so leaving and coming back picks the run up again. Lists the project's past runs.
 */
export function WorkflowsPanel({ projectId, workflows, onUsage, runs: live, open }: Props) {
  const { t, language } = useI18n()
  const [key, setKey] = useState(workflows[0]?.key ?? '')
  const [input, setInput] = useState('')
  const [steps, setSteps] = useState<LiveStep[]>([])
  /** Run shown live, and how it ended once it did. */
  const [followed, setFollowed] = useState<number | null>(null)
  const [ended, setEnded] = useState<RunStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<WorkflowRun[]>([])
  const followRef = useRef<AbortController | null>(null)
  const workflow = workflows.find((w) => w.key === key)
  const { markSeen } = live
  const current = followed !== null ? live.find(followed) : undefined
  const status: RunStatus | null = ended ?? current?.status ?? (followed !== null ? 'queued' : null)
  const running = status !== null && isActive(status)

  const loadRuns = useCallback(
    () =>
      workflowsApi.runs(projectId).then(
        (list) => (setHistory(list), list),
        () => (setHistory([]), []),
      ),
    [projectId],
  )

  /** Text and tools belong to the current step, else to the last one listed. */
  function updateRunning(change: (s: LiveStep) => LiveStep) {
    setSteps((list) => {
      const current = list.findIndex((s) => s.current)
      const at = current >= 0 ? current : list.length - 1
      return list.map((s, i) => (i === at ? change(s) : s))
    })
  }

  /** Makes step `id` the one text and tools go to. */
  function makeCurrent(id: string) {
    setSteps((list) => list.map((s) => (s.current === (s.id === id) ? s : { ...s, current: s.id === id })))
  }

  /** Changes step `id`, adding it first if it isn't listed yet. */
  function upsert(id: string, agent: string, change: (s: LiveStep) => LiveStep) {
    setSteps((list) =>
      list.some((s) => s.id === id)
        ? list.map((s) => (s.id === id ? change(s) : s))
        : [...list, change({ id, agent, status: 'pending', text: '', tools: [] })],
    )
  }

  /** Shows `runId` from its first event; leaving stops following, not the run. */
  const follow = useCallback(
    async (runId: number) => {
      followRef.current?.abort()
      const abort = new AbortController()
      followRef.current = abort
      setFollowed(runId)
      setEnded(null)
      setSteps([])
      setError(null)
      let started = false
      try {
        for await (const event of runsApi.follow(runId, abort.signal)) {
          switch (event.type) {
            case 'step_started':
              started = true
              upsert(event.id, event.agent, (s) => ({ ...s, status: 'running', approval: undefined }))
              makeCurrent(event.id)
              break
            case 'iteration_started':
              upsert(event.id, event.agent, (s) => ({
                ...s,
                status: 'running',
                round: { n: event.iteration, max: event.max },
                // Rounds after the first follow the previous one's text.
                text: s.text && `${s.text}\n\n— ${event.iteration}/${event.max} —\n\n`,
              }))
              makeCurrent(event.id)
              break
            case 'step':
              started = true
              setSteps((list) => [
                ...list,
                ...list.map((s) => ({ ...s, current: false })),
                { id: `step-${event.index + 1}`, agent: event.agent, status: 'running', text: '', tools: [], current: true },
              ])
              break
            case 'step_finished':
              upsert(event.id, '', (s) => ({ ...s, status: event.status }))
              break
            case 'approval_requested':
              started = true
              upsert(event.id, event.agent, (s) => ({
                ...s,
                status: 'waiting_approval',
                approval: { prompt: event.prompt, writes: event.writes },
              }))
              break
            case 'text':
              updateRunning((s) => ({ ...s, text: s.text + event.text }))
              break
            case 'tool':
              updateRunning((s) => ({ ...s, tools: [...s.tools, event.name] }))
              break
            case 'usage':
              onUsage(event.provider, event.details)
              break
            case 'error':
              // Before any step: the run was refused when it started.
              if (!started) setError(event.message)
              updateRunning((s) => ({ ...s, error: event.message }))
              break
            case 'finished':
              setEnded(event.status)
              if (!document.hidden) markSeen(runId)
              break
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) setError(err instanceof Error ? err.message : t('workflows.startFailed'))
      } finally {
        if (!abort.signal.aborted) void loadRuns()
      }
    },
    [loadRuns, t, onUsage, markSeen],
  )

  // Shows the run a link points at, or else picks up one in progress.
  useEffect(() => {
    void loadRuns().then((list) => {
      const target = open ?? list.find((r) => isActive(r.status))
      if (target) void follow(target.id)
    })
  }, [loadRuns, follow, open])

  useEffect(() => () => followRef.current?.abort(), [])

  async function run(e: FormEvent) {
    e.preventDefault()
    if (!workflow || !input.trim() || running) return
    setError(null)
    try {
      const { runId } = await workflowsApi.run(projectId, workflow.key, input.trim())
      void loadRuns()
      void follow(runId)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('workflows.startFailed'))
    }
  }

  async function act(action: () => Promise<unknown>) {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('activity.failed'))
    }
  }

  async function resume(id: number) {
    await act(async () => {
      const { runId } = await runsApi.resume(id)
      void loadRuns()
      void follow(runId)
    })
  }

  if (workflows.length === 0) {
    return (
      <div className="card workflows">
        <p className="hint">{t('workflows.empty')}</p>
      </div>
    )
  }

  const date = (iso: string) => new Date(iso).toLocaleString(LOCALES[language])

  return (
    <div className="card workflows">
      <form className="stack" onSubmit={run}>
        <label>
          {t('workflows.label')}
          <select value={key} disabled={running} onChange={(e) => setKey(e.target.value)}>
            {workflows.map((w) => (
              <option key={w.key} value={w.key}>
                {w.key}
              </option>
            ))}
          </select>
        </label>
        {workflow && (
          <p className="hint">
            {workflow.description} {t('workflows.steps')} {workflow.agents.join(' → ')}
          </p>
        )}
        <label>
          {workflow?.input ?? t('workflows.input')}
          <textarea rows={3} value={input} disabled={running} onChange={(e) => setInput(e.target.value)} />
        </label>
        <div className="row end">
          {running && followed !== null ? (
            <button type="button" className="secondary" onClick={() => void act(() => runsApi.abort(followed))}>
              {t('chat.stop')}
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()}>
              {t('workflows.start')}
            </button>
          )}
        </div>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {followed !== null && (
        <section className="run-live" aria-live="polite">
          <h3>
            {t('workflows.liveTitle')} #{followed}
            {status && ` · ${t(STATUS_KEY[status])}`}
          </h3>
          {status === 'queued' && <p className="hint">{reasonText(current?.reason ?? null, t, language)}</p>}
          {status === 'interrupted' && <p className="hint">{t('run.interruptedByBackend')}</p>}
          <RunSteps
            steps={steps}
            renderExtra={(s) =>
              s.status === 'waiting_approval' && s.approval && followed !== null ? (
                <Approval
                  approval={s.approval}
                  busy={running === false}
                  onApprove={() =>
                    void act(async () => {
                      await runsApi.approve(followed, s.id)
                      upsert(s.id, s.agent, (step) => ({ ...step, status: 'pending', approval: undefined }))
                    })
                  }
                  onReject={(note) => void act(() => runsApi.reject(followed, s.id, note))}
                />
              ) : null
            }
          />
        </section>
      )}

      {history.length > 0 && (
        <section className="run-history">
          <h3>{t('workflows.recent')}</h3>
          {history.map((r) => (
            <details key={r.id}>
              <summary>
                #{r.id} {r.workflow} · {t(STATUS_KEY[(live.find(r.id) ?? r).status])} · {date(r.createdAt)}
              </summary>
              <p className="hint">{r.input}</p>
              {r.error && <p className="error">{r.error}</p>}
              <div className="row">
                {isActive((live.find(r.id) ?? r).status) && r.id !== followed && (
                  <button type="button" className="link" onClick={() => void follow(r.id)}>
                    {t('workflows.follow')}
                  </button>
                )}
                {(r.status === 'interrupted' || r.status === 'failed') && (
                  <>
                    <button type="button" className="link" onClick={() => void resume(r.id)}>
                      {t('workflows.resume')}
                    </button>
                    {r.writes && <small className="hint">{t('workflows.resumeWarning')}</small>}
                  </>
                )}
              </div>
              <ol className="run-steps">
                {r.steps.map((s) => (
                  <li key={s.id}>
                    <strong>
                      {s.id} · {s.agent}
                      {s.status === 'failed' && t('workflows.errorSuffix')}
                      {s.status === 'waiting_approval' && t('workflows.waitingSuffix')}
                    </strong>
                    {(s.verdict || s.iterations) && (
                      <small className="hint">
                        {[
                          s.verdict && t('workflows.verdict', { value: s.verdict }),
                          s.iterations && t('workflows.rounds', { n: String(s.iterations.length) }),
                        ]
                          .filter(Boolean)
                          .map((part) => ` · ${part}`)
                          .join('')}
                      </small>
                    )}
                    {s.warning && <p className="hint">{s.warning}</p>}
                    {s.note && <p className="hint">{t('workflows.rejectedNote', { note: s.note })}</p>}
                    {s.output && <div className="bubble">{s.output}</div>}
                  </li>
                ))}
              </ol>
            </details>
          ))}
        </section>
      )}
    </div>
  )
}

/** What a step waiting for approval will do, and the buttons to let it or stop the run. */
function Approval({
  approval,
  busy,
  onApprove,
  onReject,
}: {
  approval: { prompt: string; writes: boolean }
  busy: boolean
  onApprove: () => void
  onReject: (note: string) => void
}) {
  const { t } = useI18n()
  const [note, setNote] = useState('')
  return (
    <div className="stack">
      <p className="hint">{t('workflows.approvalTitle')}</p>
      <div className="bubble">{approval.prompt}</div>
      <p className="hint">{t(approval.writes ? 'workflows.approvalWrites' : 'workflows.approvalReads')}</p>
      <input
        aria-label={t('workflows.rejectNote')}
        placeholder={t('workflows.rejectNote')}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="row end">
        <button type="button" className="secondary" disabled={busy} onClick={() => onReject(note)}>
          {t('workflows.reject')}
        </button>
        <button type="button" disabled={busy} onClick={onApprove}>
          {t('workflows.approve')}
        </button>
      </div>
    </div>
  )
}
