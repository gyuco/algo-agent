import { useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { missionsApi, type Mission } from './api'

/** §6.3: the push or the pull request failed; Retry, or add the token. */
export function PublishWait({
  mission,
  onChanged,
  onError,
}: {
  mission: Mission
  onChanged: () => Promise<unknown>
  onError: (message: string) => void
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const step = mission.wait?.step ?? 'push'

  async function retry() {
    if (busy) return
    setBusy(true)
    try {
      await missionsApi.retryPublish(mission.id)
      await onChanged()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('error.unexpected'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>{t('missions.wait.publishTitle')}</h2>
      <p>
        <strong>{step}</strong>: {mission.wait?.detail}
      </p>
      {step === 'token' && (
        <p className="hint">
          {t('missions.publish.vault')}{' '}
          <a href={mission.projectId === null ? '#/projects' : `#/workspace/${mission.projectId}`}>{t('nav.projects')}</a>
        </p>
      )}
      <div className="row end">
        <button type="button" disabled={busy} onClick={() => void retry()}>
          {t('missions.wait.publishRetry')}
        </button>
      </div>
    </section>
  )
}
