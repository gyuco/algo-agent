import { useState, type FormEvent } from 'react'
import { claudeApi } from './api'
import { SubscriptionConnect } from './SubscriptionConnect'
import type { ClaudeStatusState } from './useClaudeStatus'

export function ClaudeConnection({
  status,
  checking,
  busy,
  error,
  run,
  reload,
}: ClaudeStatusState) {
  const [apiKey, setApiKey] = useState('')

  const connectApiKey = (e: FormEvent) => {
    e.preventDefault()
    return run(async () => {
      const next = await claudeApi.connectApiKey(apiKey)
      setApiKey('')
      return next
    })
  }

  const disconnect = () =>
    run(async () => {
      await claudeApi.disconnect()
      await reload()
    })

  if (checking) {
    return (
      <section className="card" aria-busy="true">
        <p>Verifico la connessione a Claude Code…</p>
      </section>
    )
  }

  const problem = error ?? status?.error ?? status?.runtime?.error

  return (
    <section className="card">
      <h2>
        <span className="dot off" aria-hidden="true" /> Claude Code non connesso
      </h2>
      <p>Collega il tuo account Anthropic per usare l'agente.</p>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}

      {status?.subscriptionAvailable && <SubscriptionConnect busy={busy} run={run} />}

      <details className="option" open={!status?.subscriptionAvailable}>
        <summary>
          <strong>API key Anthropic</strong>
          {status?.subscriptionAvailable && ' (opzionale)'}
        </summary>
        <form onSubmit={connectApiKey} className="stack">
          <label>
            API key
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
            {busy ? 'Verifico…' : 'Connetti'}
          </button>
        </form>
      </details>

      {status?.method && (
        <button type="button" className="link" disabled={busy} onClick={disconnect}>
          Rimuovi la credenziale salvata
        </button>
      )}
    </section>
  )
}
