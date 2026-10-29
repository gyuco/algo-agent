import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { MISSION_STATUS_KEY, missionsApi, type MissionMode, type MissionTask } from './api'
import { BaselineWait } from './BaselineWait'
import { BriefingView } from './BriefingView'
import { BudgetBars } from './BudgetBars'
import { MilestoneWait } from './MilestoneWait'
import { PlanView } from './PlanView'
import { PreparationView } from './PreparationView'
import { PublishWait } from './PublishWait'
import { RevisionPanel } from './RevisionPanel'
import { ScopeWait } from './ScopeWait'
import { TaskBlockedWait } from './TaskBlockedWait'
import { TaskList } from './TaskList'
import { TaskReviewWait } from './TaskReviewWait'
import { TaskView } from './TaskView'
import { useMissionEvents } from './useMissionEvents'

interface Props {
  missionId: number
  onBack: () => void
  onDeleted: () => void
}

/** One mission: the task list or the briefing on the left, what is running or waiting on the right. */
export function MissionView({ missionId, onBack, onDeleted }: Props) {
  const { t } = useI18n()
  const { mission, entries, error, loading, refresh } = useMissionEvents(missionId)
  const [actionError, setActionError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'tasks' | 'briefing'>('tasks')

  const waitingTask: MissionTask | undefined =
    mission?.tasks?.find((task) => task.id === mission.wait?.taskId) ??
    mission?.tasks?.find((task) => task.key === selected)

  // Opening the mission reads it: its notifications stop counting.
  useEffect(() => {
    void missionsApi.seen(missionId).catch(() => undefined)
  }, [missionId])

  // A mission that asks something opens that task; the first one is shown otherwise.
  useEffect(() => {
    if (!mission) return
    const asked = mission.tasks?.find((task) => task.id === mission.wait?.taskId)
    if (asked) {
      setSelected(asked.key)
      setTab('tasks')
      return
    }
    if (!selected && mission.tasks?.length) setSelected(mission.tasks[0].key)
  }, [mission, selected])

  async function abort() {
    if (!mission) return
    if (!window.confirm(t('missions.abortConfirm'))) return
    setActionError(null)
    try {
      await missionsApi.abort(mission.id)
      await refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('error.unexpected'))
    }
  }

  async function resume() {
    if (!mission) return
    setActionError(null)
    try {
      await missionsApi.resume(mission.id)
      await refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('error.unexpected'))
    }
  }

  async function remove() {
    if (!mission) return
    if (!window.confirm(t('missions.deleteConfirm'))) return
    setActionError(null)
    try {
      await missionsApi.remove(mission.id)
      onDeleted()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('error.unexpected'))
    }
  }

  async function retryFinal() {
    if (!mission) return
    setActionError(null)
    try {
      await missionsApi.retryFinalChecks(mission.id)
      await refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('error.unexpected'))
    }
  }

  async function continueBudget() {
    if (!mission) return
    setActionError(null)
    try {
      await missionsApi.continueBudget(mission.id)
      await refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('error.unexpected'))
    }
  }

  async function switchMode(mode: MissionMode) {
    if (!mission || mission.mode === mode) return
    setActionError(null)
    try {
      await missionsApi.setMode(mission.id, mode)
      await refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('error.unexpected'))
    }
  }

  const setError = (message: string) => setActionError(message)

  if (error) {
    return (
      <div className="card">
        <p className="error" role="alert">
          {error}
        </p>
        <button type="button" className="secondary" onClick={onBack}>
          {t('missions.back')}
        </button>
      </div>
    )
  }
  if (loading || !mission) return <p className="hint">{t('missions.loading')}</p>

  const baseline = mission.status === 'waiting' && mission.wait?.code === 'baseline'
  const withTasks = ['running', 'paused', 'waiting', 'integrating', 'done'].includes(mission.status)
  const wait = mission.wait
  const budgetVisible = ['approved', 'running', 'paused', 'waiting', 'integrating'].includes(mission.status)

  // The first briefing has nothing beside it: it takes the whole panel, like the chat.
  const briefingOnly = !withTasks && mission.status === 'briefing'

  return (
    <div className={briefingOnly ? 'mission-view briefing-only' : 'mission-view'}>
      <header className="mission-header">
        <button type="button" className="secondary" onClick={onBack}>
          ← {t('missions.back')}
        </button>
        <h1 className="workspace-title">{mission.title}</h1>
        <span className={`badge ${mission.status !== 'briefing' ? 'accent' : ''}`}>
          {t(MISSION_STATUS_KEY[mission.status])}
        </span>
        <span className="hint">{t('missions.planVersionShort', { n: String(mission.planVersion) })}</span>
        {budgetVisible && mission.budget && <BudgetBars budget={mission.budget} compact />}
        {['running', 'paused', 'waiting'].includes(mission.status) && (
          <label className="hint">
            {t('missions.mode')}
            <select
              value={mission.mode}
              onChange={(e) => void switchMode(e.target.value as MissionMode)}
            >
              <option value="step">{t('missions.modeStep')}</option>
              <option value="auto">{t('missions.modeAuto')}</option>
            </select>
          </label>
        )}
        <div className="row">
          {mission.status !== 'aborted' && mission.status !== 'done' && (
            <button type="button" className="danger" onClick={() => void abort()}>
              {t('missions.abort')}
            </button>
          )}
          {mission.status === 'aborted' && (
            <button type="button" onClick={() => void resume()}>
              {t('missions.resume')}
            </button>
          )}
          {(mission.status === 'approved' || mission.status === 'aborted') && (
            <button type="button" className="secondary" onClick={() => void remove()}>
              {t('missions.delete')}
            </button>
          )}
        </div>
      </header>
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      <div className={briefingOnly ? 'mission-columns briefing-only' : 'mission-columns'}>
        {withTasks ? (
          <div className="mission-left">
            <div className="row tabs">
              <button type="button" className={tab === 'tasks' ? '' : 'secondary'} onClick={() => setTab('tasks')}>
                {t('missions.tasks')}
              </button>
              <button
                type="button"
                className={tab === 'briefing' ? '' : 'secondary'}
                onClick={() => setTab('briefing')}
              >
                {t('missions.briefing')}
              </button>
            </div>
            {tab === 'tasks' ? (
              <TaskList mission={mission} selected={selected} onSelect={setSelected} />
            ) : (
              <BriefingView mission={mission} entries={entries} onChanged={refresh} />
            )}
          </div>
        ) : (
          <BriefingView mission={mission} entries={entries} onChanged={refresh} />
        )}
        <div className="mission-right">
          {mission.status === 'planned' && <PlanView mission={mission} onChanged={refresh} />}
          {mission.status === 'approved' && (
            <PreparationView mission={mission} onChanged={refresh} onError={setError} />
          )}
          {baseline && (
            <BaselineWait mission={mission} entries={entries} onChanged={refresh} onError={setError} />
          )}
          {wait?.code === 'task_review' && waitingTask && (
            <TaskReviewWait mission={mission} task={waitingTask} onChanged={refresh} onError={setError} />
          )}
          {wait?.code === 'task_blocked' && waitingTask && (
            <TaskBlockedWait mission={mission} task={waitingTask} onChanged={refresh} onError={setError} />
          )}
          {wait?.code === 'final_checks' && (
            <section className="card">
              <h2>{t('missions.wait.finalTitle')}</h2>
              <p className="error" role="alert">
                {wait.detail}
              </p>
              <div className="row end">
                <button type="button" onClick={() => void retryFinal()}>
                  {t('missions.wait.retry')}
                </button>
              </div>
            </section>
          )}
          {mission.status === 'paused' && (
            <section className="card">
              <h2>{t('missions.wait.pausedTitle')}</h2>
              <p className="hint">{t('missions.wait.pausedHint')}</p>
              {wait?.until && (
                <p>
                  {t('missions.wait.until', {
                    when: new Intl.DateTimeFormat(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(new Date(wait.until)),
                  })}
                </p>
              )}
              {mission.budget && <BudgetBars budget={mission.budget} />}
            </section>
          )}
          {wait?.code === 'weekly_budget' && (
            <section className="card">
              <h2>{t('missions.wait.weeklyTitle')}</h2>
              <p className="hint">
                {wait.scope === 'global' ? t('missions.wait.weeklyGlobal') : t('missions.wait.weeklyMission')}
              </p>
              {wait.until && (
                <p>
                  {t('missions.wait.until', {
                    when: new Intl.DateTimeFormat(undefined, {
                      weekday: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(new Date(wait.until)),
                  })}
                </p>
              )}
              {mission.budget && <BudgetBars budget={mission.budget} />}
              <div className="row end">
                <button type="button" onClick={() => void continueBudget()}>
                  {t('missions.wait.continue')}
                </button>
              </div>
            </section>
          )}
          {wait?.code === 'usd_budget' && (
            <section className="card">
              <h2>{t('missions.wait.usdTitle')}</h2>
              {mission.budget && <BudgetBars budget={mission.budget} />}
              <div className="row end">
                <button type="button" onClick={() => void continueBudget()}>
                  {t('missions.wait.continue')}
                </button>
              </div>
            </section>
          )}
          {wait?.code === 'scope' && (
            <ScopeWait mission={mission} onChanged={refresh} onError={setError} />
          )}
          {wait?.code === 'milestone' && (
            <MilestoneWait mission={mission} onChanged={refresh} onError={setError} />
          )}
          {wait?.code === 'revision' && (
            <RevisionPanel mission={mission} entries={entries} />
          )}
          {wait?.code === 'publish' && (
            <PublishWait mission={mission} onChanged={refresh} onError={setError} />
          )}
          {mission.status === 'integrating' && (
            <section className="card">
              <h2>{t('missions.status.integrating')}</h2>
              <p className="hint">{t('missions.publish.hint')}</p>
            </section>
          )}
          {mission.status === 'done' && (
            <section className="card mission-ready">
              <h2>{t('missions.done.title')}</h2>
              <p>
                {t('missions.done.branch')} <code>{mission.branch ?? '—'}</code>
              </p>
              {mission.prUrl ? (
                <p>
                  {t('missions.done.pr')}:{' '}
                  <a href={mission.prUrl} target="_blank" rel="noreferrer">
                    {mission.prUrl}
                  </a>
                </p>
              ) : (
                <p className="hint">{t('missions.done.localOnly')}</p>
              )}
            </section>
          )}
          {withTasks && selected && (
            <TaskView
              missionId={mission.id}
              taskKey={selected}
              onError={setError}
            />
          )}
          {mission.status === 'aborted' && (
            <section className="card">
              <p className="hint">{t('missions.abortedHint')}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
