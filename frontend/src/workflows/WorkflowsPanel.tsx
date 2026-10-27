import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { WorkflowResource } from '../agents/api'
import type { RateLimitSnapshot } from '../claude/api'
import { LOCALES, type MessageKey } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import { workflowsApi, type RunStatus, type WorkflowRun } from './api'

interface LiveStep {
  agent: string
  text: string
  tools: string[]
  error?: string
}

const STATUS_KEY: Record<RunStatus, MessageKey> = {
  running: 'status.running',
  done: 'status.done',
  failed: 'status.failed',
  aborted: 'status.aborted',
}

interface Props {
  projectId: number
  /** Workflows switched on in the project. */
  workflows: WorkflowResource[]
  onUsage: (rateLimits: RateLimitSnapshot) => void
}

/** Starts a workflow, follows its steps live and lists the project's past runs. */
export function WorkflowsPanel({ projectId, workflows, onUsage }: Props) {
  const { t, language } = useI18n()
  const [key, setKey] = useState(workflows[0]?.key ?? '')
  const [input, setInput] = useState('')
  const [steps, setSteps] = useState<LiveStep[]>([])
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const workflow = workflows.find((w) => w.key === key)
  const running = status === 'running'

  const loadRuns = useCallback(() => {
    workflowsApi.runs(projectId).then(setRuns, () => setRuns([]))
  }, [projectId])

  useEffect(loadRuns, [loadRuns])
  useEffect(() => () => abortRef.current?.abort(), [])

  function updateLast(change: (s: LiveStep) => LiveStep) {
    setSteps((list) => list.map((s, i) => (i === list.length - 1 ? change(s) : s)))
  }

  async function run(e: FormEvent) {
    e.preventDefault()
    if (!workflow || !input.trim() || running) return
    setSteps([])
    setError(null)
    setStatus('running')
    const abort = new AbortController()
    abortRef.current = abort
    let finished: RunStatus = 'failed'
    try {
      for await (const event of workflowsApi.run(projectId, workflow.key, input.trim(), abort.signal)) {
        switch (event.type) {
          case 'step':
            setSteps((list) => [...list, { agent: event.agent, text: '', tools: [] }])
            break
          case 'text':
            updateLast((s) => ({ ...s, text: s.text + event.text }))
            break
          case 'tool':
            updateLast((s) => ({ ...s, tools: [...s.tools, event.name] }))
            break
          case 'usage':
            onUsage(event.rateLimits)
            break
          case 'error':
            updateLast((s) => ({ ...s, error: event.message }))
            break
          case 'finished':
            finished = event.status
            break
        }
      }
    } catch (err) {
      if (abort.signal.aborted) finished = 'aborted'
      else setError(err instanceof Error ? err.message : t('workflows.startFailed'))
    } finally {
      setStatus(abort.signal.aborted ? 'aborted' : finished)
      loadRuns()
    }
  }

  if (workflows.length === 0) {
    return (
      <div className="card workflows">
        <p className="hint">{t('workflows.empty')}</p>
      </div>
    )
  }

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
          <textarea
            rows={3}
            value={input}
            disabled={running}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <div className="row end">
          {running ? (
            <button type="button" className="secondary" onClick={() => abortRef.current?.abort()}>
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

      {steps.length > 0 && (
        <section className="run-live" aria-live="polite">
          <h3>
            {t('workflows.liveTitle')}
            {status && ` · ${t(STATUS_KEY[status])}`}
          </h3>
          <ol className="run-steps">
            {steps.map((s, i) => (
              <li key={i}>
                <strong>{s.agent}</strong>
                {s.tools.length > 0 && (
                  <ul className="tools">
                    {s.tools.map((t, j) => (
                      <li key={j}>{t}</li>
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

      {runs.length > 0 && (
        <section className="run-history">
          <h3>{t('workflows.recent')}</h3>
          {runs.map((r) => (
            <details key={r.id}>
              <summary>
                {r.workflow} · {t(STATUS_KEY[r.status])} · {new Date(r.createdAt).toLocaleString(LOCALES[language])}
              </summary>
              <p className="hint">{r.input}</p>
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
