import { claudeApi, type ClaudeStatus, type RateLimitWindow } from './api'
import type { RunAction } from './useClaudeStatus'

const WINDOW_LABEL: Record<string, string> = {
  five_hour: 'Sessione (5 ore)',
  seven_day: 'Settimana',
  seven_day_opus: 'Settimana · Opus',
  seven_day_sonnet: 'Settimana · Sonnet',
  overage: 'Extra',
}

const dateTime = new Intl.DateTimeFormat('it-IT', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})
const date = new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium' })
const relative = new Intl.RelativeTimeFormat('it-IT', { numeric: 'auto' })

function ago(iso: string) {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000)
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour')
  return relative.format(Math.round(hours / 24), 'day')
}

function Meter({ name, window }: { name: string; window: RateLimitWindow }) {
  const percent = window.utilization === null ? null : Math.round(window.utilization * 100)
  const level =
    window.status === 'rejected' ? 'high' : window.status === 'allowed_warning' || (percent ?? 0) >= 80 ? 'warn' : 'ok'
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{WINDOW_LABEL[name] ?? name}</span>
        <strong>{percent === null ? '—' : `${percent}%`}</strong>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={WINDOW_LABEL[name] ?? name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div className={`meter-fill ${level}`} style={{ width: `${percent ?? 0}%` }} />
      </div>
      {window.resetsAt && (
        <small>Si azzera {dateTime.format(new Date(window.resetsAt))}</small>
      )}
    </div>
  )
}

interface Props {
  status: ClaudeStatus
  busy: boolean
  run: RunAction
}

/** Plan usage and session details, like Claude Code's `/usage`. */
export function UsagePanel({ status, busy, run }: Props) {
  const { session, method } = status
  if (!session) return null
  const isSubscription = method === 'oauth_token'
  const limits = session.rateLimits

  return (
    <section className="card usage" aria-label="Utilizzo Claude">
      <div className="usage-head">
        <h2>Utilizzo</h2>
        <span className="badge">{isSubscription ? 'Abbonamento Claude' : 'API key'}</span>
      </div>

      {isSubscription &&
        (limits ? (
          <>
            <div className="meters">
              {Object.entries(limits.windows).map(([name, window]) => (
                <Meter key={name} name={name} window={window} />
              ))}
            </div>
            {limits.status === 'rejected' && (
              <p className="error" role="alert">
                Limite del piano raggiunto.
              </p>
            )}
          </>
        ) : (
          <p>Limiti del piano non ancora rilevati.</p>
        ))}

      <dl className="facts">
        <div>
          <dt>Claude Code</dt>
          <dd>{session.claudeCodeVersion ?? '—'}</dd>
        </div>
        <div>
          <dt>Modelli</dt>
          <dd>{session.models.map((m) => m.displayName).join(', ') || '—'}</dd>
        </div>
        <div>
          <dt>Connesso dal</dt>
          <dd>{date.format(new Date(session.connectedAt))}</dd>
        </div>
        {session.tokenExpiresAt && (
          <div>
            <dt>Token scade</dt>
            <dd>circa {date.format(new Date(session.tokenExpiresAt))}</dd>
          </div>
        )}
      </dl>

      {isSubscription && (
        <div className="usage-foot">
          <small>
            {limits ? `Aggiornato ${ago(limits.observedAt)}` : 'Mai aggiornato'} · l'aggiornamento
            invia un prompt minimo e usa una piccola quota
          </small>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => run(claudeApi.refreshUsage)}
          >
            {busy ? 'Aggiorno…' : 'Aggiorna'}
          </button>
        </div>
      )}
    </section>
  )
}
