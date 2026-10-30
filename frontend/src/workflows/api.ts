import { api } from '../api/client'

/** Who fills one of the agents a workflow names, for one run; the slot is that agent's key. */
export interface WorkflowAssign {
  slot: string
  agent: string
  /** `<provider>:<model>`; the agent's model when omitted. */
  model?: string
  effort?: string
}

export interface StartWorkflow {
  input: string
  /** Chat conversation the run belongs to; omitted in a new conversation. */
  sessionId?: string
  assign?: WorkflowAssign[]
}

export const workflowsApi = {
  /** Queues a run; follow it with runsApi.follow. */
  run: (projectId: number, key: string, body: StartWorkflow) =>
    api<{ runId: number }>(`/projects/${projectId}/workflows/${encodeURIComponent(key)}/runs`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
}
