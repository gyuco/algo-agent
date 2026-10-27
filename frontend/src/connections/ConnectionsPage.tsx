import { LOCALES } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import { connectionsApi, type ConnectionStatus } from './api'
import { PROVIDER_UI } from './providers'
import type { ConnectionsState, RunAction } from './useConnections'

/** Every provider the app can run agents with: connect, check and disconnect each one. */
export function ConnectionsPage({ state }: { state: ConnectionsState }) {
  const { t } = useI18n()
  const { connections, checking, busy, error, run, reload } = state

  return (
    <>
      <h1>{t('connections.title')}</h1>
      <p className="hint">{t('connections.intro')}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {checking && connections.length === 0 ? (
        <p className="hint" aria-busy="true">
          {t('connections.checking')}
        </p>
      ) : (
        <div className="connections">
          {connections.map((c) => (
            <ConnectionCard key={c.provider} connection={c} busy={busy || checking} run={run} reload={reload} />
          ))}
        </div>
      )}
    </>
  )
}

interface CardProps {
  connection: ConnectionStatus
  busy: boolean
  run: RunAction
  reload: () => Promise<void>
}

function ConnectionCard({ connection, busy, run, reload }: CardProps) {
  const { t, language } = useI18n()
  const ui = PROVIDER_UI[connection.provider]
  const { connected, method, methods } = connection
  const methodKey = method ? ui?.methodLabels[method] : undefined
  const date = new Intl.DateTimeFormat(LOCALES[language], { dateStyle: 'medium' })

  const disconnect = () =>
    run(async () => {
      await connectionsApi.disconnect(connection.provider)
      await reload()
    })

  return (
    <section className="card connection" aria-label={connection.label}>
      <div className="usage-head">
        <h2>
          <span className={`dot ${connected ? 'ok' : 'off'}`} aria-hidden="true" /> {connection.label}
        </h2>
        <span className="badge">{t(connected ? 'connections.connected' : 'connections.notConnected')}</span>
      </div>
      {connection.error && (
        <p className="error" role="alert">
          {connection.error}
        </p>
      )}

      {connected ? (
        <>
          <dl className="facts">
            <div>
              <dt>{t('connections.method')}</dt>
              <dd>
                {methodKey ? t(methodKey) : method} {connection.secretHint && <code>{connection.secretHint}</code>}
              </dd>
            </div>
            <div>
              <dt>{t('connections.version')}</dt>
              <dd>{connection.version ?? '—'}</dd>
            </div>
            {connection.connectedAt && (
              <div>
                <dt>{t('connections.since')}</dt>
                <dd>{date.format(new Date(connection.connectedAt))}</dd>
              </div>
            )}
          </dl>
          <details>
            <summary>{t('connections.models', { count: String(connection.models.length) })}</summary>
            <ul className="model-list">
              {connection.models.map((m) => (
                <li key={m.value}>{m.displayName}</li>
              ))}
            </ul>
          </details>
          {ui?.Details && <ui.Details connection={connection} busy={busy} run={run} />}
          <div className="row end">
            <button type="button" className="secondary" disabled={busy} onClick={disconnect}>
              {t('connections.disconnect')}
            </button>
          </div>
        </>
      ) : (
        <>
          {methods.length > 0 && ui ? (
            <ui.Connect connection={connection} busy={busy} run={run} />
          ) : (
            <p className="hint">{t('connections.unavailable')}</p>
          )}
          {/* A stored connection that no longer works can still be removed. */}
          {method && (
            <button type="button" className="link" disabled={busy} onClick={disconnect}>
              {t('connections.remove')}
            </button>
          )}
        </>
      )}
    </section>
  )
}
