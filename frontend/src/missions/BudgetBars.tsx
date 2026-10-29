import { useI18n } from '../i18n/useI18n'
import { LOCALES } from '../i18n/messages'
import type { BudgetView } from './api'

function pct(value: number) {
  return Math.round(Math.min(1, Math.max(0, value)) * 100)
}

function Bar({
  label,
  used,
  detail,
  threshold,
  level,
}: {
  label: string
  used: number
  detail?: string
  threshold?: number
  level?: 'ok' | 'warn' | 'high'
}) {
  const head = pct(used)
  const limit = threshold === undefined ? null : pct(threshold)
  const tone = level ?? (head >= 90 ? 'high' : head >= 75 ? 'warn' : 'ok')
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <strong>{head}%</strong>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={head}
      >
        <div className={`meter-fill ${tone}`} style={{ width: `${head}%` }} />
        {limit !== null && (
          <span
            className="meter-threshold"
            style={{ left: `${limit}%` }}
            title={`${limit}%`}
            aria-hidden="true"
          />
        )}
      </div>
      {detail && <small>{detail}</small>}
    </div>
  )
}

/** The budget of one mission: the 5-hour window, the week's share and the dollar cap. */
export function BudgetBars({ budget, compact = false }: { budget: BudgetView; compact?: boolean }) {
  const { t, language } = useI18n()
  const format = new Intl.DateTimeFormat(LOCALES[language], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  const reset = (iso?: string) => (iso ? format.format(new Date(iso)) : '—')
  if (compact && !budget.fiveHour && !budget.week) return null

  return (
    <div className={`budget ${compact ? 'budget-compact' : ''}`} aria-label={t('missions.budget.title')}>
      {budget.fiveHour && (
        <Bar
          label={t('missions.budget.fiveHour')}
          used={budget.fiveHour.used}
          threshold={1 - budget.fiveHour.threshold}
          detail={reset(budget.fiveHour.resetsAt)}
        />
      )}
      {budget.week && (
        <Bar
          label={`${t('missions.budget.mission')} · ${t('missions.budget.week')}`}
          used={budget.week.missionUsed}
          threshold={budget.week.missionAllowance}
          detail={`${t('missions.budget.global')}: ${pct(budget.week.globalUsed)}% / ${pct(budget.week.globalCap)}% · ${reset(budget.week.resetsAt)}`}
        />
      )}
      {budget.week && (
        <Bar
          label={t('missions.budget.global')}
          used={budget.week.globalUsed}
          threshold={budget.week.globalCap}
          detail={t('missions.budget.estimate')}
        />
      )}
      <small className="hint">
        {budget.usd.allowance !== undefined
          ? `${t('missions.budget.spent', { n: `$${budget.usd.spent.toFixed(2)}` })} / $${budget.usd.allowance.toFixed(2)}`
          : t('missions.budget.spent', { n: `$${budget.usd.spent.toFixed(2)}` })}
        {budget.source === 'none' && ` · ${t('missions.budget.none')}`}
        {budget.source !== 'plan' && budget.usd.allowance === undefined && ` · ${t('missions.budget.uncontrollable')}`}
        {budget.source === 'plan' && ` · ${t('missions.budget.estimate')}`}
      </small>
    </div>
  )
}
