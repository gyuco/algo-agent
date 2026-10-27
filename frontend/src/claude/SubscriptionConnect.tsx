import { useState, type FormEvent } from 'react'
import { claudeApi, type SetupTokenStart } from './api'
import type { RunAction } from '../connections/useConnections'
import { useI18n } from '../i18n/useI18n'

interface Props {
  busy: boolean
  run: RunAction
}

/** Connects a Claude Pro/Max subscription through `claude setup-token`. */
export function SubscriptionConnect({ busy, run }: Props) {
  const { t } = useI18n()
  const [setup, setSetup] = useState<SetupTokenStart | null>(null)
  const [code, setCode] = useState('')
  const [token, setToken] = useState('')

  const start = () =>
    run(async () => {
      const started = await claudeApi.startSetupToken()
      setSetup(started)
      window.open(started.authorizeUrl, '_blank', 'noopener')
    })

  const complete = (e: FormEvent) => {
    e.preventDefault()
    if (!setup) return
    return run(async () => {
      try {
        return await claudeApi.completeSetupToken(setup.sessionId, code)
      } finally {
        // The CLI session ends either way; a retry needs a fresh sign-in.
        setSetup(null)
        setCode('')
      }
    })
  }

  const paste = (e: FormEvent) => {
    e.preventDefault()
    return run(() => claudeApi.connectOAuthToken(token))
  }

  return (
    <div className="option">
      <strong>{t('connect.subscriptionTitle')}</strong>

      {!setup ? (
        <>
          <p>
            {t('connect.setupLead')} <code>claude setup-token</code>
            {t('connect.setupTail')}
          </p>
          <button type="button" disabled={busy} onClick={start}>
            {busy ? t('connect.starting') : t('connect.subscribe')}
          </button>
        </>
      ) : (
        <form onSubmit={complete} className="stack">
          <p>
            {t('connect.authorizeLead')}{' '}
            <a href={setup.authorizeUrl} target="_blank" rel="noopener noreferrer">
              claude.com
            </a>{' '}
            {t('connect.authorizeTail')}
          </p>
          <label>
            {t('connect.authCode')}
            <input
              autoComplete="off"
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <div className="row">
            <button type="submit" disabled={busy}>
              {busy ? t('connect.verifying') : t('connect.confirm')}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setSetup(null)}>
              {t('connect.cancel')}
            </button>
          </div>
        </form>
      )}

      <details>
        <summary>{t('connect.hasToken')}</summary>
        <form onSubmit={paste} className="stack">
          <p>
            {t('connect.tokenLead')} <code>claude setup-token</code> {t('connect.tokenTail')}
          </p>
          <label>
            {t('connect.tokenLabel')}
            <input
              type="password"
              autoComplete="off"
              placeholder="sk-ant-oat01-…"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? t('connect.verifying') : t('connect.saveToken')}
          </button>
        </form>
      </details>
    </div>
  )
}
