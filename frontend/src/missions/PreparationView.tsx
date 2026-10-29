import { useEffect, useState } from 'react'
import type { MessageKey } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import { runsApi, type PrepareStep } from '../runs/api'
import { missionsApi, type Mission } from './api'

const STEPS: PrepareStep[] = [
  'create_folder',
  'git_init',
  'create_repo',
  'push_base',
  'register_project',
  'fetch',
  'branch',
  'worktree',
  'setup',
  'build',
  'lint',
  'test',
]

const STEP_KEY: Record<PrepareStep, MessageKey> = {
  create_folder: 'missions.prepareStep.create_folder',
  git_init: 'missions.prepareStep.git_init',
  create_repo: 'missions.prepareStep.create_repo',
  push_base: 'missions.prepareStep.push_base',
  register_project: 'missions.prepareStep.register_project',
  fetch: 'missions.prepareStep.fetch',
  branch: 'missions.prepareStep.branch',
  worktree: 'missions.prepareStep.worktree',
  setup: 'missions.prepareStep.setup',
  build: 'missions.prepareStep.build',
  lint: 'missions.prepareStep.lint',
  test: 'missions.prepareStep.test',
}

type StepState = {
  status: 'pending' | 'started' | 'done' | 'failed' | 'skipped'
  detail?: string
}

const STATUS_KEY: Record<StepState['status'], MessageKey> = {
  pending: 'missions.step.pending',
  started: 'missions.step.started',
  done: 'missions.step.done',
  failed: 'missions.step.failed',
  skipped: 'missions.step.skipped',
}

const OPEN_OUTPUT = 20_000

interface Props {
  mission: Mission
  onChanged: () => Promise<unknown>
  onError: (message: string) => void
}

/** The preparation after an approval: steps and live output from its run. */
export function PreparationView({ mission, onChanged, onError }: Props) {
  const { t } = useI18n()
  const [steps, setSteps] = useState<Record<string, StepState>>({})
  const [output, setOutput] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [ended, setEnded] = useState(false)
  const [busy, setBusy] = useState(false)
  const runId = mission.preparation?.runId

  useEffect(() => {
    if (!runId) return
    const abort = new AbortController()
    setSteps({})
    setOutput({})
    setError(null)
    setEnded(false)
    void (async () => {
      try {
        for await (const event of runsApi.follow(runId, abort.signal)) {
          if (event.type === 'prepare_step') {
            setSteps((current) => ({
              ...current,
              [event.step]: { status: event.status, detail: event.detail },
            }))
          } else if (event.type === 'check_output') {
            setOutput((current) => ({
              ...current,
              [event.name]: `${current[event.name] ?? ''}${event.text}`.slice(-OPEN_OUTPUT),
            }))
          } else if (event.type === 'error') {
            setError(event.message)
          } else if (event.type === 'finished') {
            setEnded(true)
            void onChanged()
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          setError(err instanceof Error ? err.message : t('error.unexpected'))
        }
      }
    })()
    return () => abort.abort()
  }, [runId, onChanged, t])

  async function revise() {
    if (busy) return
    setBusy(true)
    try {
      await missionsApi.revise(mission.id)
      await onChanged()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('error.unexpected'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card mission-preparation">
      <header className="row spread">
        <h2>{t('missions.preparation')}</h2>
        <span className={`badge ${ended ? '' : 'accent'}`}>
          {ended ? t('missions.preparationDone') : t('missions.preparationLive')}
        </span>
      </header>
      {!runId ? (
        <p className="hint">{t('missions.preparationQueued')}</p>
      ) : (
        <ol className="prepare-steps">
          {STEPS.map((step) => {
            const state = steps[step] ?? { status: 'pending' as const }
            return (
              <li key={step}>
                <div className="row spread">
                  <strong>{t(STEP_KEY[step])}</strong>
                  <span className={`badge ${state.status === 'failed' ? 'warn' : ''}`}>
                    {t(STATUS_KEY[state.status])}
                  </span>
                </div>
                {state.detail && <p className="hint">{state.detail}</p>}
                {output[step] && (
                  <details>
                    <summary>{t('missions.output')}</summary>
                    <div className="bubble">{output[step]}</div>
                  </details>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row plan-actions">
        <span className="hint">{t('missions.preparationHint')}</span>
        <button type="button" className="secondary" disabled={busy} onClick={() => void revise()}>
          {t('missions.revise')}
        </button>
      </div>
    </section>
  )
}
