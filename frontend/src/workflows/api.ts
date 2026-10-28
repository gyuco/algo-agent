import { api } from '../api/client'
import type { Run } from '../runs/api'

/** A workflow run as the project's list returns it. */
export type WorkflowRun = Run

export const workflowsApi = {
  runs: (projectId: number) => api<WorkflowRun[]>(`/projects/${projectId}/workflows/runs`),
  /** Queues a run; follow it with runsApi.follow. */
  run: (projectId: number, key: string, input: string) =>
    api<{ runId: number }>(`/projects/${projectId}/workflows/${encodeURIComponent(key)}/runs`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    }),
}
