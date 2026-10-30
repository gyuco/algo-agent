import type { WorkflowResource } from '../agents/api'
import type { WorkflowAssign } from './api'

/** Who fills each agent the workflow names, by slot; a slot left out keeps its agent and model. */
export type Team = Record<string, { agent: string; model: string; effort: string }>

/** The agents a workflow names, each once, in the order its steps use them. */
export const slotsOf = (workflow: WorkflowResource) => [...new Set(workflow.agents)]

/** What the API takes: only the slots changed from the workflow's own. */
export function assignOf(team: Team): WorkflowAssign[] {
  return Object.entries(team)
    .filter(([slot, c]) => c.agent !== slot || c.model || c.effort)
    .map(([slot, c]) => ({
      slot,
      agent: c.agent,
      model: c.model || undefined,
      effort: c.effort || undefined,
    }))
}
