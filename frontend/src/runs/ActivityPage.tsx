import { useEffect, useState } from 'react'
import type { MessageKey } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import { BudgetBars } from '../missions/BudgetBars'
import { missionsApi, MISSION_STATUS_KEY, type MissionActivity, type MissionCard } from '../missions/api'
import { runsApi, type Run } from './api'
import { reasonText } from './reason'
import { needsUser, runLink, STATUS_KEY, type ActiveRunsState } from './useActiveRuns'

const GROUPS: [MessageKey, (run: Run) => boolean][] = [
  ['activity.attention', needsUser],
  ['activity.running', (r) => r.status === 'running'],
  ['activity.queued', (r) => r.status === 'queued'],
  ['activity.recent', (r) => !needsUser(r) && Boolean(r.finishedAt)],
]

function duration(from: string, to: Date) {
  const seconds = Math.max(0, Math.round((to.getTime() - new Date(from).getTime()) / 1000))
  const m = Math.floor(seconds / 60)
  return m ? `${m}m ${seconds % 60}s` : `${seconds}s`
}

/** Why a mission is in Richiedono te, in words. */
function missionWaitText(card: MissionCard, t: (key: MessageKey, vars?: Record<string, string>) => string) {
  if (card.status === 'paused') return t('missions.wait.pausedTitle')
  const code = card.wait?.code
  if (code === 'task_review') return t('activity.missionReview', { key: `#${card.wait?.taskId ?? '—'}` })
  if (code === 'task_blocked') return t('activity.missionBlocked', { key: `#${card.wait?.taskId ?? '—'}` })
  if (code === 'scope') return t('missions.wait.scopeTitle', { key: `#${card.wait?.taskId ?? '—'}` })
  if (code === 'final_checks') return t('activity.missionFinal')
  if (code === 'milestone') return t('missions.wait.milestoneTitle')
  if (code === 'weekly_budget') return t('missions.wait.weeklyTitle')
  if (code === 'usd_budget') return t('missions.wait.usdTitle')
  if (code === 'publish') return t('missions.wait.publishTitle')
  if (code === 'baseline') return t('missions.baseline.title')
  return code ?? t('missions.waiting')
}

/** Chats, missions and workflows of every project: what runs, what waits, what ended, with their actions. */
export function ActivityPage({
  state,
  missions = 0,
  notify,
}: {
  state: ActiveRunsState
  missions?: number
  notify?: () => void
}) {
  const { t } = useI18n()
  const [permission, setPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  )
  const [error, setError] = useState<string | null>(null)
  /** Missions waiting for the user and missions in progress, with their tasks. */
  const [activity, setActivity] = useState<MissionActivity | null>(null)
  // Running durations move on their own.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 5000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    let alive = true
    void missionsApi
      .activity()
      .then((value) => alive && setActivity(value))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [state.runs, missions])

  async function act(action: () => Promise<unknown>) {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('activity.failed'))
    }
  }

  const placed = new Set<number>()
  const groups = GROUPS.map(([title, test]) => {
    const runs = state.runs.filter((r) => !placed.has(r.id) && test(r))
    runs.forEach((r) => placed.add(r.id))
    return { title, runs }
  }).filter((g) => g.runs.length > 0)

  return (
    <>
      <h1>{t('activity.title')}</h1>
      <p className="hint">{t('activity.intro')}</p>
      {typeof Notification !== 'undefined' && (
        <p className="hint">
          {permission === 'granted' ? (
            t('activity.notifyOn')
          ) : permission === 'denied' ? (
            t('activity.notifyBlocked')
          ) : (
            <button type="button" className="link" onClick={() => {
              notify?.()
              void Notification.requestPermission().then(setPermission)
            }}>
              {t('activity.notify')}
            </button>
          )}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {activity && activity.waiting.length > 0 && (
        <section className="activity-group">
          <h2>{t('activity.missions')}</h2>
          <ul className="activity-list">
            {activity.waiting.map((card) => (
              <li key={card.id} className={card.unread ? 'activity-item unread' : 'activity-item'}>
                <div className="activity-main">
                  <span className="activity-title">
                    <span className="badge accent">{t('activity.mission')}</span> {card.title}
                    {card.unread && <span className="badge accent">{t('activity.unread')}</span>}
                  </span>
                  <small>{missionWaitText(card, t)}</small>
                </div>
                <div className="row">
                  <a
                    className="button secondary"
                    href={`#/workspace/${card.projectId}/mission/${card.id}`}
                  >
                    {t('activity.open')}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {activity && activity.running.length > 0 && (
        <section className="activity-group">
          <h2>{t('activity.missionsRunning')}</h2>
          <ul className="activity-list">
            {activity.running.map((card) => (
              <li key={card.id} className="activity-item">
                <div className="activity-main">
                  <span className="activity-title">
                    <span className="badge">{t('activity.mission')}</span> {card.title}
                  </span>
                  <small>
                    {card.projectName} · {t(MISSION_STATUS_KEY[card.status])}
                    {card.milestone &&
                      ` · ${card.milestone.title} ${card.milestone.done}/${card.milestone.total}`}
                  </small>
                  {card.activeTasks.length > 0 && (
                    <small className="activity-detail">
                      {card.activeTasks
                        .map((task) => [task.key, task.step, task.last].filter(Boolean).join(' · '))
                        .join(' | ')}
                    </small>
                  )}
                  <BudgetBars budget={card.budget} compact />
                </div>
                <div className="row">
                  <a
                    className="button secondary"
                    href={`#/workspace/${card.projectId}/mission/${card.id}`}
                  >
                    {t('activity.open')}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!state.loaded && <p className="hint">{t('activity.loading')}</p>}
      {state.loaded && groups.length === 0 && (activity?.waiting.length ?? 0) === 0 && (activity?.running.length ?? 0) === 0 && <p className="hint">{t('activity.empty')}</p>}
      {groups.map((g) => (
        <section key={g.title} className="activity-group">
          <h2>{t(g.title)}</h2>
          <ul className="activity-list">
            {g.runs.map((run) => (
              <ActivityRow
                key={run.id}
                run={run}
                now={now}
                onOpen={() => state.markSeen(run.id)}
                onStop={() => void act(() => runsApi.abort(run.id))}
                onResume={() => void act(() => runsApi.resume(run.id))}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

function ActivityRow({
  run,
  now,
  onOpen,
  onStop,
  onResume,
}: {
  run: Run
  now: Date
  onOpen: () => void
  onStop: () => void
  onResume: () => void
}) {
  const { t, language } = useI18n()
  const started = run.startedAt ?? run.createdAt
  const ended = run.finishedAt ? new Date(run.finishedAt) : now
  const detail =
    run.status === 'queued'
      ? reasonText(run.reason, t, language)
      : [
          run.activity?.step &&
            t('activity.step', { step: run.activity.step.id, agent: run.activity.step.agent }),
          run.activity?.last,
          run.error,
        ]
          .filter(Boolean)
          .join(' · ')

  return (
    <li className={run.unread ? 'activity-item unread' : 'activity-item'}>
      <div className="activity-main">
        <span className="activity-title">
          <span className="badge">
            {t(
              run.kind === 'chat'
                ? 'activity.chat'
                : run.kind === 'workflow'
                  ? 'activity.workflow'
                  : 'activity.mission',
            )}
          </span>{' '}
          {run.title || t('sessions.untitled')}
          {run.unread && <span className="badge accent">{t('activity.unread')}</span>}
        </span>
        <small>
          {run.projectName} · {t(STATUS_KEY[run.status])} · {duration(started, ended)}
          {run.costUsd > 0 && ` · $${run.costUsd.toFixed(2)}`}
        </small>
        {detail && <small className="activity-detail">{detail}</small>}
      </div>
      <div className="row">
        <a className="button secondary" href={runLink(run)} onClick={onOpen}>
          {t('activity.open')}
        </a>
        {(run.status === 'queued' || run.status === 'running' || run.status === 'waiting') && (
          <button type="button" className="secondary" onClick={onStop}>
            {t('activity.stop')}
          </button>
        )}
        {run.kind === 'workflow' && (run.status === 'interrupted' || run.status === 'failed') && (
          <button
            type="button"
            className="secondary"
            title={run.writes ? t('workflows.resumeWarning') : undefined}
            onClick={onResume}
          >
            {t('activity.resume')}
          </button>
        )}
      </div>
    </li>
  )
}
