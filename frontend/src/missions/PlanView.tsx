import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import {
  missionsApi,
  type Mission,
  type MissionMode,
  type PlanCommand,
} from './api'

const command = (value: PlanCommand) =>
  typeof value === 'string' ? value : `${value.run}${value.workdir ? ` (${value.workdir})` : ''}`

interface Props {
  mission: Mission
  onChanged: () => Promise<unknown>
}

/** The structured plan, with approval and revision. */
export function PlanView({ mission, onChanged }: Props) {
  const { t } = useI18n()
  const [mode, setMode] = useState<MissionMode>(mission.mode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const plan = mission.plan

  useEffect(() => setMode(mission.mode), [mission.mode])

  if (!plan) {
    return (
      <section className="card mission-plan">
        <h2>{t('missions.plan')}</h2>
        <p className="hint">{t('missions.planPending')}</p>
      </section>
    )
  }

  async function act(action: 'approve' | 'revise') {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (action === 'approve') {
        await missionsApi.approve(mission.id, {
          planVersion: mission.planVersion,
          mode,
        })
      } else {
        await missionsApi.revise(mission.id)
      }
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.unexpected'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card mission-plan">
      <header className="row spread">
        <h2>{t('missions.plan')}</h2>
        <span className="badge">{t('missions.version', { n: String(mission.planVersion) })}</span>
      </header>
      <p className="plan-goal">{plan.goal}</p>

      <dl className="plan-facts">
        <dt>{t('missions.baseBranch')}</dt>
        <dd>
          {mission.baseBranch ?? plan.baseBranch ?? '—'}
          {!mission.baseBranch && <span className="badge warn">{t('missions.noGit')}</span>}
        </dd>
        <dt>{t('missions.scope')}</dt>
        <dd>
          {plan.scope.paths.length ? plan.scope.paths.join(', ') : t('missions.scopeAll')}
          {plan.scope.migrations && ` · ${t('missions.migrations')}`}
          {plan.scope.dependencies.length > 0 &&
            ` · ${t('missions.dependencies')}: ${plan.scope.dependencies.join(', ')}`}
          {plan.scope.tests.length > 0 &&
            ` · ${t('missions.tests')}: ${plan.scope.tests.join(', ')}`}
        </dd>
        <dt>{t('missions.checks')}</dt>
        <dd>
          {(['setup', 'build', 'lint', 'test'] as const)
            .filter((name) => plan.checks[name])
            .map((name) => (
              <div key={name}>
                <code>
                  {name}: {command(plan.checks[name]!)}
                </code>
              </div>
            ))}
          {!plan.checks.parallel && <div className="hint">{t('missions.checksSequential')}</div>}
        </dd>
        <dt>{t('missions.team')}</dt>
        <dd>
          {Object.entries(plan.team.roles).map(([role, spec]) => (
            <div key={role}>
              <strong>{role}</strong> · {spec.agent} · {spec.model} · {t('missions.turns', { n: String(spec.maxTurns) })}
            </div>
          ))}
          {plan.team.custom.map((agent) => (
            <div key={agent.key}>
              <strong>{agent.key}</strong> · {agent.model} · {agent.permissions.files}
            </div>
          ))}
        </dd>
        <dt>{t('missions.budget')}</dt>
        <dd>
          {t('missions.budgetDetail', {
            five: String(plan.budget.fiveHourMinRemaining),
            week: String(plan.budget.weeklyMaxShare),
          })}
          {' · '}
          {t('missions.parallel', { n: String(plan.parallelTasks) })}
        </dd>
        {mission.planEstimate !== undefined && (
          <>
            <dt>{t('missions.estimate')}</dt>
            <dd>{t('missions.sessions', { n: String(mission.planEstimate) })}</dd>
          </>
        )}
      </dl>

      <div className="plan-milestones">
        {plan.milestones.map((milestone) => (
          <section key={milestone.id}>
            <h3>{milestone.title ?? milestone.id}</h3>
            <ul className="plan-tasks">
              {milestone.tasks.map((task) => (
                <li key={task.key}>
                  <div className="row spread">
                    <strong>{task.title ?? task.key}</strong>
                    <code>{task.key}</code>
                  </div>
                  <p className="hint">
                    {t('missions.template', { key: task.template })}
                    {task.needs.length > 0 &&
                      ` · ${t('missions.needs', { keys: task.needs.join(', ') })}`}
                    {Object.keys(task.agents).length > 0 &&
                      ` · ${Object.entries(task.agents)
                        .map(([role, agent]) => `${role}: ${agent}`)
                        .join(', ')}`}
                  </p>
                  <ul>
                    {task.acceptance.map((criterion, i) => (
                      <li key={i}>{criterion}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {mission.validationErrors && mission.validationErrors.length > 0 && (
        <div className="error" role="alert">
          <strong>{t('missions.planInvalid')}</strong>
          <ul>
            {mission.validationErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {mission.status === 'planned' && (
        <div className="row plan-actions">
          <label>
            {t('missions.mode')}
            <select value={mode} onChange={(e) => setMode(e.target.value as MissionMode)}>
              <option value="step">{t('missions.modeStep')}</option>
              <option value="auto">{t('missions.modeAuto')}</option>
            </select>
          </label>
          <button type="button" className="secondary" onClick={() => document.getElementById('mission-input')?.focus()}>
            {t('missions.comment')}
          </button>
          <button
            type="button"
            disabled={busy || Boolean(mission.validationErrors?.length)}
            onClick={() => void act('approve')}
          >
            {t('missions.approve')}
          </button>
        </div>
      )}
      {mission.status === 'approved' && (
        <div className="row plan-actions">
          <span className="badge accent">
            {t('missions.approvedBadge', { n: String(mission.approvedVersion ?? mission.planVersion) })}
          </span>
          <span className="hint">{t('missions.phaseTwo')}</span>
          <button type="button" className="secondary" disabled={busy} onClick={() => void act('revise')}>
            {t('missions.revise')}
          </button>
        </div>
      )}
      {mission.status === 'aborted' && <p className="hint">{t('missions.abortedHint')}</p>}
    </section>
  )
}
