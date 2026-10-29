import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { missionsApi, type MissionMode, type MissionTask } from './api'
import { BaselineWait } from './BaselineWait'
import { BriefingView } from './BriefingView'
import { BudgetBars } from './BudgetBars'
import { MilestoneWait } from './MilestoneWait'
import { MissionProgress } from './MissionProgress'
import { MissionTeam } from './MissionTeam'
import { missionStage } from './missionStage'
import { PlanView } from './PlanView'
import { PreparationView } from './PreparationView'
import { PublishWait } from './PublishWait'
import { RevisionPanel } from './RevisionPanel'
import { ScopeWait } from './ScopeWait'
import { TaskBlockedWait } from './TaskBlockedWait'
import { TeamModels } from './TeamModels'
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
  // A task the user opened stays open; otherwise the view follows the one at work.
  const [pinned, setPinned] = useState(false)
  const askedRef = useRef<number | null>(null)
  const actionRef = useRef<HTMLDivElement>(null)

  const waitingTask: MissionTask | undefined =
    mission?.tasks?.find((task) => task.id === mission.wait?.taskId) ??
    mission?.tasks?.find((task) => task.key === selected)

  // Opening the mission reads it: its notifications stop counting.
  useEffect(() => {
    void missionsApi.seen(missionId).catch(() => undefined)
  }, [missionId])

  // A task that asks something opens once; then the running task, the opened one, or the first.
  useEffect(() => {
    if (!mission) return
    const asked = mission.tasks?.find((task) => task.id === mission.wait?.taskId)
    if (asked && askedRef.current !== asked.id) {
      askedRef.current = asked.id
      setSelected(asked.key)
      setTab('tasks')
      setPinned(false)
      return
    }
    if (!asked && askedRef.current !== null) {
      askedRef.current = null
      setPinned(false)
      return
    }
    if (pinned && selected) return
    const running = mission.tasks?.find((task) => task.status === 'running' || task.status === 'merging')
    const next = asked?.key ?? running?.key ?? selected ?? mission.tasks?.[0]?.key ?? null
    if (next !== selected) setSelected(next)
  }, [mission, selected, pinned])

  const pick = (key: string) => {
    setSelected(key)
    setPinned(true)
  }

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
  const live = ['running', 'paused', 'waiting'].includes(mission.status)
  const stage = missionStage(mission)
  const needsYou = stage.holder === 'you'
  // The briefing's question is answered in the conversation, not in a card.
  const inConversation = stage.message === 'missions.now.question'
  // The card of a task waiting on the user already shows its outcome and diff.
  const taskInCard =
    (wait?.code === 'task_review' || wait?.code === 'task_blocked') && waitingTask?.key === selected
  const selectedTask = mission.tasks?.find((task) => task.key === selected)

  // The first briefing has nothing beside it: it takes the whole panel, like the chat.
  const briefingOnly = !withTasks && mission.status === 'briefing'

  function goToAction() {
    if (inConversation) {
      setTab('briefing')
      requestAnimationFrame(() => document.getElementById('mission-input')?.focus())
      return
    }
    actionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const untilTime = (until: string, weekday: boolean) =>
    new Intl.DateTimeFormat(undefined, {
      ...(weekday ? { weekday: 'short' as const } : {}),
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(until))

  return (
    <div className={briefingOnly ? 'mission-view briefing-only' : 'mission-view'}>
      <header className="mission-header">
        <button type="button" className="secondary" onClick={onBack}>
          ← {t('missions.back')}
        </button>
        <h1 className="workspace-title">{mission.title}</h1>
        <div className="row">
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
          {mission.status !== 'aborted' && mission.status !== 'done' && (
            <button type="button" className="secondary danger-text" onClick={() => void abort()}>
              {t('missions.abort')}
            </button>
          )}
        </div>
      </header>
      <MissionProgress mission={mission} onGo={goToAction} />
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      <div className={briefingOnly ? 'mission-columns briefing-only' : 'mission-columns'}>
        {withTasks ? (
          <div className="mission-left">
            <div className="row tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'tasks'}
                className={tab === 'tasks' ? '' : 'secondary'}
                onClick={() => setTab('tasks')}
              >
                {t('missions.tasks')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'briefing'}
                className={tab === 'briefing' ? '' : 'secondary'}
                onClick={() => setTab('briefing')}
              >
                {t('missions.conversation')}
              </button>
            </div>
            {tab === 'tasks' ? (
              <TaskList mission={mission} selected={selected} onSelect={pick} />
            ) : (
              <BriefingView mission={mission} entries={entries} onChanged={refresh} />
            )}
            {tab === 'tasks' && <MissionTeam mission={mission} />}
            {live && (
              <details className="card mission-settings">
                <summary>{t('missions.settings')}</summary>
                <label>
                  {t('missions.mode')}
                  <select value={mission.mode} onChange={(e) => void switchMode(e.target.value as MissionMode)}>
                    <option value="step">{t('missions.modeStep')}</option>
                    <option value="auto">{t('missions.modeAuto')}</option>
                  </select>
                </label>
                {mission.budget && <BudgetBars budget={mission.budget} />}
                <h3>{t('missions.team')}</h3>
                <p className="hint">{t('missions.teamHint')}</p>
                <TeamModels key={mission.planVersion} mission={mission} onChanged={refresh} onError={setError} />
              </details>
            )}
          </div>
        ) : (
          <BriefingView mission={mission} entries={entries} onChanged={refresh} />
        )}
        <div className="mission-right">
          <div ref={actionRef} className={needsYou && !inConversation ? 'mission-action' : 'mission-status'}>
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
                {wait?.until && <p>{t('missions.wait.until', { when: untilTime(wait.until, false) })}</p>}
                {mission.budget && <BudgetBars budget={mission.budget} />}
              </section>
            )}
            {wait?.code === 'weekly_budget' && (
              <section className="card">
                <h2>{t('missions.wait.weeklyTitle')}</h2>
                <p className="hint">
                  {wait.scope === 'global' ? t('missions.wait.weeklyGlobal') : t('missions.wait.weeklyMission')}
                </p>
                {wait.until && <p>{t('missions.wait.until', { when: untilTime(wait.until, true) })}</p>}
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
            {wait?.code === 'scope' && <ScopeWait mission={mission} onChanged={refresh} onError={setError} />}
            {wait?.code === 'milestone' && (
              <MilestoneWait mission={mission} onChanged={refresh} onError={setError} />
            )}
            {wait?.code === 'revision' && <RevisionPanel mission={mission} entries={entries} />}
            {wait?.code === 'publish' && <PublishWait mission={mission} onChanged={refresh} onError={setError} />}
            {mission.status === 'done' && (
              <section className="card mission-ready">
                <h2>{t('missions.done.title')}</h2>
                <p>
                  {t('missions.done.branch')} <code>{mission.branch ?? '—'}</code>
                </p>
                {mission.prUrl ? (
                  <a className="button" href={mission.prUrl} target="_blank" rel="noreferrer">
                    {t('missions.done.openPr')} ↗
                  </a>
                ) : (
                  <p className="hint">{t('missions.done.localOnly')}</p>
                )}
              </section>
            )}
          </div>
          {withTasks && selected && (
            <TaskView
              missionId={mission.id}
              taskKey={selected}
              status={selectedTask?.status}
              compact={taskInCard}
              team={mission.plan?.team}
              onError={setError}
            />
          )}
        </div>
      </div>
    </div>
  )
}
