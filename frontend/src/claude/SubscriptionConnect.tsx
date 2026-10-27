import { useState, type FormEvent } from 'react'
import { claudeApi, type SetupTokenStart } from './api'
import type { RunAction } from './useClaudeStatus'

interface Props {
  busy: boolean
  run: RunAction
}

/** Connects a Claude Pro/Max subscription through `claude setup-token`. */
export function SubscriptionConnect({ busy, run }: Props) {
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
      <strong>Abbonamento Claude Pro / Max</strong>

      {!setup ? (
        <>
          <p>
            Avvia <code>claude setup-token</code>: si apre la pagina di Anthropic
            dove autorizzi l'accesso e ricevi un codice.
          </p>
          <button type="button" disabled={busy} onClick={start}>
            {busy ? 'Avvio…' : 'Collega abbonamento'}
          </button>
        </>
      ) : (
        <form onSubmit={complete} className="stack">
          <p>
            Autorizza su{' '}
            <a href={setup.authorizeUrl} target="_blank" rel="noopener noreferrer">
              claude.com
            </a>{' '}
            (se la pagina non si è aperta), poi incolla qui il codice.
          </p>
          <label>
            Codice di autorizzazione
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
              {busy ? 'Verifico…' : 'Conferma'}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setSetup(null)}>
              Annulla
            </button>
          </div>
        </form>
      )}

      <details>
        <summary>Hai già un token di accesso?</summary>
        <form onSubmit={paste} className="stack">
          <p>
            Generalo da terminale con <code>claude setup-token</code> e incollalo qui.
          </p>
          <label>
            Token di accesso
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
            {busy ? 'Verifico…' : 'Salva token'}
          </button>
        </form>
      </details>
    </div>
  )
}
