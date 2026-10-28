import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { WorkflowResource } from '../agents/api'
import { LOCALES } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import { isActive, runsApi, type Run, type RunStatus } from '../runs/api'
import { reasonText } from '../runs/reason'
import { STATUS_KEY, type ActiveRunsState } from '../runs/useActiveRuns'
import { workflowsApi, type WorkflowRun } from './api'

interface LiveStep {
  agent: string
  text: string
  tools: string[]
  error?: string
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

  function updateLast(change: (s: LiveStep) => LiveStep) {
    setSteps((list) => list.map((s, i) => (i === list.length - 1 ? change(s) : s)))
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
            case 'step':
              started = true
              setSteps((list) => [...list, { agent: event.agent, text: '', tools: [] }])
              break
            case 'text':
              updateLast((s) => ({ ...s, text: s.text + event.text }))
              break
            case 'tool':
              updateLast((s) => ({ ...s, tools: [...s.tools, event.name] }))
              break
            case 'usage':
              onUsage(event.provider, event.details)
              break
            case 'error':
              // Before any step: the run was refused when it started.
              if (!started) setError(event.message)
              updateLast((s) => ({ ...s, error: event.message }))
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
          <ol className="run-steps">
            {steps.map((s, i) => (
              <li key={i}>
                <strong>{s.agent}</strong>
                {s.tools.length > 0 && (
                  <ul className="tools">
                    {s.tools.map((tool, j) => (
                      <li key={j}>{tool}</li>
                    ))}
                  </ul>
                )}
                {s.text && <div className="bubble">{s.text}</div>}
                {s.error && (
                  <p className="error" role="alert">
                    {s.error}
                  </p>
                )}
              </li>
            ))}
          </ol>
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
                {r.steps.map((s, i) => (
                  <li key={i}>
                    <strong>
                      {s.agent}
                      {s.isError && t('workflows.errorSuffix')}
                    </strong>
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
