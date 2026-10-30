import type { AgentResource, WorkflowResource } from '../agents/api'
import { ModelMenu, type ModelOption } from '../chat/ModelMenu'
import { useI18n } from '../i18n/useI18n'
import { slotsOf, type Team } from './team'

interface Props {
  workflow: WorkflowResource
  /** Agents switched on in the project, any of which can fill a slot. */
  agents: AgentResource[]
  models: ModelOption[]
  /** Effort levels a model accepts. */
  effortsOf: (model: string) => string[]
  team: Team
  disabled: boolean
  onChange: (team: Team) => void
}

/**
 * Above the composer when a workflow is chosen: what it does, and for each
 * agent it names, the agent and model that will fill it in this run.
 */
export function WorkflowTeam({ workflow, agents, models, effortsOf, team, disabled, onChange }: Props) {
  const { t } = useI18n()
  const fill = (slot: string) => team[slot] ?? { agent: slot, model: '', effort: '' }
  const set = (slot: string, change: Partial<Team[string]>) =>
    onChange({ ...team, [slot]: { ...fill(slot), ...change } })

  return (
    <div className="workflow-team">
      <p className="hint">
        {workflow.description} {t('workflows.steps')} {workflow.agents.join(' → ')}
      </p>
      <ul>
        {slotsOf(workflow).map((slot) => {
          const chosen = fill(slot)
          const agent = agents.find((a) => a.key === chosen.agent)
          const efforts = effortsOf(chosen.model)
          return (
            <li key={slot}>
              <span className="slot">{slot}</span>
              <select
                aria-label={t('workflows.agentFor', { slot })}
                value={chosen.agent}
                disabled={disabled}
                onChange={(e) => set(slot, { agent: e.target.value })}
              >
                {/* The workflow's own agent, even when the project has it off: the run will say so. */}
                {!agent && <option value={chosen.agent}>{chosen.agent}</option>}
                {agents.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.key}
                  </option>
                ))}
              </select>
              <ModelMenu
                models={models}
                defaultLabel={
                  agent?.model ? t('chat.agentModel', { model: agent.model }) : t('chat.defaultModel')
                }
                model={chosen.model}
                efforts={efforts}
                effort={efforts.includes(chosen.effort) ? chosen.effort : ''}
                disabled={disabled}
                onModel={(model) =>
                  set(slot, { model, effort: effortsOf(model).includes(chosen.effort) ? chosen.effort : '' })
                }
                onEffort={(effort) => set(slot, { effort })}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
