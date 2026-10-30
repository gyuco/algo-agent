import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { isActive, runsApi, type Run, type RunStatus, type StepStatus } from '../runs/api'
import { reasonText } from '../runs/reason'
import { RunSteps } from '../runs/RunSteps'
import { STATUS_KEY, type ActiveRunsState } from '../runs/useActiveRuns'

interface LiveStep {
  id: string
  agent: string
  model?: string
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
  runId: number
  /** Provider details a step reported, e.g. Claude's plan usage. */
  onUsage: (provider: string, details: Record<string, unknown>) => void
  /** The user's runs, kept live: why the run waits to start. */
  runs: ActiveRunsState
  /** The run ended, or was already over when shown. */
  onEnd?: (runId: number, status: RunStatus) => void
  /** A resume started: the new run to show after this one. */
  onResumed?: (runId: number) => void
}

/**
 * A workflow run inside the chat: its steps as they stream, from the first
 * event, so a past run replays the same way. Approvals, stop and resume sit on it.
 */
export function WorkflowRunCard({ runId, onUsage, runs, onEnd, onResumed }: Props) {
  const { t, language } = useI18n()
  const [run, setRun] = useState<Run | null>(null)
  const [steps, setSteps] = useState<LiveStep[]>([])
  const [ended, setEnded] = useState<RunStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { markSeen } = runs
  const live = runs.find(runId)
  const status: RunStatus = ended ?? live?.status ?? run?.status ?? 'queued'
  const running = isActive(status)

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

  useEffect(() => {
    const abort = new AbortController()
    runsApi.get(runId).then(setRun, () => undefined)
    let started = false
    void (async () => {
      try {
        for await (const event of runsApi.follow(runId, abort.signal)) {
          switch (event.type) {
            case 'step_started':
              started = true
              upsert(event.id, event.agent, (s) => ({
                ...s,
                agent: event.agent,
                model: event.model ?? s.model,
                status: 'running',
                approval: undefined,
              }))
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
              onEnd?.(runId, event.status)
              if (!document.hidden) markSeen(runId)
              break
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) setError(err instanceof Error ? err.message : t('workflows.startFailed'))
      }
    })()
    return () => abort.abort()
    // Follows the run once; the callbacks only report what it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  async function act(action: () => Promise<unknown>) {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('activity.failed'))
    }
  }

  return (
    <section className="workflow-run" aria-label={t('workflows.label')}>
      <header className="workflow-run-head">
        <strong>{run?.workflow ?? t('workflows.label')}</strong>
        <small className="hint">
          #{runId} · {t(STATUS_KEY[status])}
        </small>
        {running && (
          <button type="button" className="link" onClick={() => void act(() => runsApi.abort(runId))}>
            {t('chat.stop')}
          </button>
        )}
      </header>
      {run && <div className="bubble">{run.input}</div>}
      {status === 'queued' && <p className="hint">{reasonText(live?.reason ?? null, t, language)}</p>}
      {status === 'interrupted' && <p className="hint">{t('run.interruptedByBackend')}</p>}
      <RunSteps
        steps={steps}
        renderExtra={(s) =>
          s.status === 'waiting_approval' && s.approval ? (
            <Approval
              approval={s.approval}
              busy={!running}
              onApprove={() =>
                void act(async () => {
                  await runsApi.approve(runId, s.id)
                  upsert(s.id, s.agent, (step) => ({ ...step, status: 'pending', approval: undefined }))
                })
              }
              onReject={(note) => void act(() => runsApi.reject(runId, s.id, note))}
            />
          ) : null
        }
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {onResumed && (status === 'interrupted' || status === 'failed') && (
        <div className="row">
          <button
            type="button"
            className="link"
            onClick={() =>
              void act(async () => {
                const { runId: resumed } = await runsApi.resume(runId)
                onResumed(resumed)
              })
            }
          >
            {t('workflows.resume')}
          </button>
          {run?.writes && <small className="hint">{t('workflows.resumeWarning')}</small>}
        </div>
      )}
    </section>
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
