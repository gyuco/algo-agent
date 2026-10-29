import { useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { missionsApi, type Mission, type Plan } from './api'

interface Diff {
  added: string[]
  removed: string[]
  changed: string[]
  sections: string[]
  milestones: string[]
}

/** A plain comparison of the approved plan and the proposed one, enough for the screen. */
function compare(before: Plan | undefined, after: Plan): Diff {
  if (!before) {
    return {
      added: after.milestones.flatMap((m) => m.tasks.map((task) => task.key)),
      removed: [],
      changed: [],
      sections: [],
      milestones: after.milestones.map((m) => m.id),
    }
  }
  const oldTasks = new Map(
    before.milestones.flatMap((m) =>
      m.tasks.map((task) => [task.key, JSON.stringify(task)] as const),
    ),
  )
  const newTasks = new Map(
    after.milestones.flatMap((m) =>
      m.tasks.map((task) => [task.key, JSON.stringify(task)] as const),
    ),
  )
  const added = [...newTasks.keys()].filter((key) => !oldTasks.has(key))
  const removed = [...oldTasks.keys()].filter((key) => !newTasks.has(key))
  const changed = [...newTasks.keys()].filter(
    (key) => oldTasks.has(key) && oldTasks.get(key) !== newTasks.get(key),
  )
  const sections = (['scope', 'checks', 'team', 'budget'] as const).filter(
    (name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]),
  )
  return {
    added,
    removed,
    changed,
    sections,
    milestones: after.milestones
      .map((m) => m.id)
      .filter((id) => !before.milestones.some((m) => m.id === id)),
  }
}

/** §5.5: the plan proposed during the mission, waiting for the user's Ok. */
export function MilestoneWait({
  mission,
  onChanged,
  onError,
}: {
  mission: Mission
  onChanged: () => Promise<unknown>
  onError: (message: string) => void
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const plan = mission.plan
  if (!plan) return null
  const before = mission.wait?.previousPlan as Plan | undefined
  const diff = compare(before, plan)

  async function approve() {
    if (busy) return
    setBusy(true)
    try {
      await missionsApi.approve(mission.id, {
        planVersion: mission.planVersion,
        mode: mission.mode,
      })
      await onChanged()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('error.unexpected'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>{t('missions.wait.milestoneTitle')}</h2>
      <p className="hint">{t('missions.wait.milestoneHint')}</p>
      {mission.wait?.detail && <p>{mission.wait.detail}</p>}
      <dl className="plan-facts">
        {diff.added.length > 0 && (
          <>
            <dt>{t('missions.milestone.added')}</dt>
            <dd>{diff.added.join(', ')}</dd>
          </>
        )}
        {diff.removed.length > 0 && (
          <>
            <dt>{t('missions.milestone.removed')}</dt>
            <dd>{diff.removed.join(', ')}</dd>
          </>
        )}
        {diff.changed.length > 0 && (
          <>
            <dt>{t('missions.milestone.changed')}</dt>
            <dd>{diff.changed.join(', ')}</dd>
          </>
        )}
        {diff.sections.length > 0 && (
          <>
            <dt>{t('missions.milestone.sections')}</dt>
            <dd>{diff.sections.join(', ')}</dd>
          </>
        )}
        {diff.milestones.length > 0 && (
          <>
            <dt>{t('missions.milestone.new')}</dt>
            <dd>{diff.milestones.join(', ')}</dd>
          </>
        )}
      </dl>
      <div className="row end">
        <button
          type="button"
          className="secondary"
          onClick={() => document.getElementById('mission-input')?.focus()}
        >
          {t('missions.comment')}
        </button>
        <button type="button" disabled={busy} onClick={() => void approve()}>
          {t('missions.approve')}
        </button>
      </div>
    </section>
  )
}
