import type { ProviderUiProps } from '../connections/providers'
import { LOCALES, type MessageKey } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import { claudeApi, type ClaudeDetails, type RateLimitWindow } from './api'

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

/** Plan usage of a Claude subscription, like Claude Code's `/usage`. */
export function UsagePanel({ connection, busy, run }: ProviderUiProps) {
  const { t, language } = useI18n()
  if (connection.method !== 'oauth_token') return null
  const details = connection.details as ClaudeDetails | undefined
  const fmt = formatters(LOCALES[language])
  const limits = details?.rateLimits

  return (
    <div className="usage" aria-label={t('usage.section')}>
      {limits ? (
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
      )}

      <div className="usage-foot">
        <small>
          {limits ? t('usage.updated', { when: ago(limits.observedAt, fmt) }) : t('usage.never')}
          {details?.tokenExpiresAt &&
            ` · ${t('usage.tokenExpires')} ${t('usage.about', {
              date: fmt.date.format(new Date(details.tokenExpiresAt)),
            })}`}{' '}
          · {t('usage.refreshNote')}
        </small>
        <button type="button" className="secondary" disabled={busy} onClick={() => run(claudeApi.refreshUsage)}>
          {busy ? t('usage.refreshing') : t('usage.refresh')}
        </button>
      </div>
    </div>
  )
}
