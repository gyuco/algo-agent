import type { ReactNode } from 'react'
import { useI18n } from '../i18n/useI18n'
import type { StepStatus } from './api'

/** One step as the live views keep it while its run streams. */
export interface RunStep {
  id: string
  agent: string
  status: StepStatus
  text: string
  tools: string[]
  error?: string
  /** The last one started, where text and tools go. */
  current?: boolean
  round?: { n: number; max: number }
}

/** A run's steps: text, tools and rounds, shared by workflows and mission tasks. */
export function RunSteps<T extends RunStep>({
  steps,
  renderExtra,
}: {
  steps: T[]
  renderExtra?: (step: T, index: number) => ReactNode
}) {
  const { t } = useI18n()
  return (
    <ol className="run-steps">
      {steps.map((s, i) => (
        <li key={i}>
          <strong>
            {s.id} · {s.agent}
          </strong>
          {s.round && (
            <small className="hint">
              {' '}
              · {t('workflows.round', { n: String(s.round.n), max: String(s.round.max) })}
            </small>
          )}
          {renderExtra?.(s, i)}
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
  )
}
