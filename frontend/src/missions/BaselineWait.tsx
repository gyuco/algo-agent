import { useState } from 'react'
import type { MessageKey } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import { missionsApi, type Mission, type MissionEntry } from './api'

const STEP_KEY: Record<string, MessageKey> = {
  fetch: 'missions.prepareStep.fetch',
  branch: 'missions.prepareStep.branch',
  worktree: 'missions.prepareStep.worktree',
  setup: 'missions.prepareStep.setup',
  build: 'missions.prepareStep.build',
  lint: 'missions.prepareStep.lint',
  test: 'missions.prepareStep.test',
}

interface Props {
  mission: Mission
  entries: MissionEntry[]
  onChanged: () => Promise<unknown>
  onError: (message: string) => void
}

/** The `baseline` wait: what failed, why, and the three things the user can do. */
export function BaselineWait({ mission, entries, onChanged, onError }: Props) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const last = entries.filter((entry) => entry.kind === 'wait').at(-1)
  const data = (last?.data ?? {}) as {
    step?: string
    detail?: string
    output?: string
  }
  const detail = mission.wait?.detail ?? data.detail
  const step = mission.wait?.step ?? data.step

  async function act(action: 'retry' | 'revise' | 'abort') {
    if (busy) return
    setBusy(true)
    try {
      if (action === 'retry') await missionsApi.retryBaseline(mission.id)
      else if (action === 'revise') await missionsApi.revise(mission.id)
      else await missionsApi.abort(mission.id)
      await onChanged()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('error.unexpected'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card mission-baseline">
      <header className="row spread">
        <h2>{t('missions.baseline.title')}</h2>
        {step && <span className="badge warn">{t(STEP_KEY[step] ?? 'missions.baseline.title')}</span>}
      </header>
      <p className="hint">{t('missions.baseline.hint')}</p>
      {detail && <div className="bubble">{detail}</div>}
      {data.output && (
        <details>
          <summary>{t('missions.output')}</summary>
          <div className="bubble">{data.output}</div>
        </details>
      )}
      <div className="row plan-actions">
        <button type="button" disabled={busy} onClick={() => void act('retry')}>
          {t('missions.baseline.retry')}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void act('revise')}>
          {t('missions.revise')}
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void act('abort')}>
          {t('missions.abort')}
        </button>
      </div>
    </section>
  )
}
