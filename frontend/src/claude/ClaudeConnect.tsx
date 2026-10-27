import { useState, type FormEvent } from 'react'
import type { ProviderUiProps } from '../connections/providers'
import { useI18n } from '../i18n/useI18n'
import { claudeApi } from './api'
import { SubscriptionConnect } from './SubscriptionConnect'

/** Connects Claude Code with a subscription (personal mode) or an Anthropic API key. */
export function ClaudeConnect({ connection, busy, run }: ProviderUiProps) {
  const { t } = useI18n()
  const [apiKey, setApiKey] = useState('')
  const subscriptionAvailable = connection.methods.includes('oauth_token')

  const connectApiKey = (e: FormEvent) => {
    e.preventDefault()
    return run(async () => {
      const next = await claudeApi.connectApiKey(apiKey)
      setApiKey('')
      return next
    })
  }

  return (
    <>
      <p>{t('connect.intro')}</p>
      {subscriptionAvailable && <SubscriptionConnect busy={busy} run={run} />}

      <details className="option" open={!subscriptionAvailable}>
        <summary>
          <strong>{t('connect.apiKeyTitle')}</strong>
          {subscriptionAvailable && ` ${t('connect.optional')}`}
        </summary>
        <form onSubmit={connectApiKey} className="stack">
          <label>
            {t('connect.apiKeyLabel')}
            <input
              type="password"
              autoComplete="off"
              placeholder="sk-ant-…"
              required
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? t('connect.verifying') : t('connect.connect')}
          </button>
        </form>
      </details>
    </>
  )
}
