import { LOCALES, type MessageKey } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import { claudeApi, type ClaudeStatus, type RateLimitWindow } from './api'
import type { RunAction } from './useClaudeStatus'

const WINDOW_KEY: Record<string, MessageKey> = {
  five_hour: 'usage.window.five_hour',
  seven_day: 'usage.window.seven_day',
  seven_day_opus: 'usage.window.seven_day_opus',
  seven_day_sonnet: 'usage.window.seven_day_sonnet',
  overage: 'usage.window.overage',
}

type Formatters = ReturnType<typeof formatters>

function formatters(locale: string) {
  return {
    dateTime: new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }),
    date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }),
    relative: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
  }
}

function ago(iso: string, { relative }: Formatters) {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000)
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour')
  return relative.format(Math.round(hours / 24), 'day')
}

function Meter({
  name,
  window,
  fmt,
}: {
  name: string
  window: RateLimitWindow
  fmt: Formatters
}) {
  const { t } = useI18n()
  const percent = window.utilization === null ? null : Math.round(window.utilization * 100)
  const level =
    window.status === 'rejected' ? 'high' : window.status === 'allowed_warning' || (percent ?? 0) >= 80 ? 'warn' : 'ok'
  const label = WINDOW_KEY[name] ? t(WINDOW_KEY[name]) : name
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <strong>{percent === null ? '—' : `${percent}%`}</strong>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div className={`meter-fill ${level}`} style={{ width: `${percent ?? 0}%` }} />
      </div>
      {window.resetsAt && (
        <small>{t('usage.resets', { when: fmt.dateTime.format(new Date(window.resetsAt)) })}</small>
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
  const { t, language } = useI18n()
  const { session, method } = status
  if (!session) return null
  const fmt = formatters(LOCALES[language])
  const isSubscription = method === 'oauth_token'
  const limits = session.rateLimits

  return (
    <section className="card usage" aria-label={t('usage.title')}>
      <div className="usage-head">
        <h2>{t('usage.section')}</h2>
        <span className="badge">{t(isSubscription ? 'usage.subscription' : 'usage.apiKey')}</span>
      </div>

      {isSubscription &&
        (limits ? (
          <>
            <div className="meters">
              {Object.entries(limits.windows).map(([name, window]) => (
                <Meter key={name} name={name} window={window} fmt={fmt} />
              ))}
            </div>
            {limits.status === 'rejected' && (
              <p className="error" role="alert">
                {t('usage.limitReached')}
              </p>
            )}
          </>
        ) : (
          <p>{t('usage.notDetected')}</p>
        ))}

      <dl className="facts">
        <div>
          <dt>{t('usage.claudeCode')}</dt>
          <dd>{session.claudeCodeVersion ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('usage.models')}</dt>
          <dd>{session.models.map((m) => m.displayName).join(', ') || '—'}</dd>
        </div>
        <div>
          <dt>{t('usage.connectedSince')}</dt>
          <dd>{fmt.date.format(new Date(session.connectedAt))}</dd>
        </div>
        {session.tokenExpiresAt && (
          <div>
            <dt>{t('usage.tokenExpires')}</dt>
            <dd>{t('usage.about', { date: fmt.date.format(new Date(session.tokenExpiresAt)) })}</dd>
          </div>
        )}
      </dl>

      {isSubscription && (
        <div className="usage-foot">
          <small>
            {limits
              ? t('usage.updated', { when: ago(limits.observedAt, fmt) })
              : t('usage.never')}{' '}
            · {t('usage.refreshNote')}
          </small>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => run(claudeApi.refreshUsage)}
          >
            {busy ? t('usage.refreshing') : t('usage.refresh')}
          </button>
        </div>
      )}
    </section>
  )
}
