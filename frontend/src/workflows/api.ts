import { api, apiStream } from '../api/client'
import type { ChatEvent } from '../chat/api'

export type RunStatus = 'running' | 'done' | 'failed' | 'aborted'

export interface StepResult {
  agent: string
  output: string
  isError: boolean
}

export interface WorkflowRun {
  id: number
  workflow: string
  input: string
  status: RunStatus
  steps: StepResult[]
  createdAt: string
}

export type WorkflowEvent =
  | { type: 'run'; runId: number }
  | { type: 'step'; index: number; agent: string }
  | ChatEvent
  | { type: 'finished'; status: RunStatus }

export const workflowsApi = {
  runs: (projectId: number) => api<WorkflowRun[]>(`/projects/${projectId}/workflows/runs`),
  run: (projectId: number, key: string, input: string, signal: AbortSignal) =>
    apiStream<WorkflowEvent>(
      `/projects/${projectId}/workflows/${encodeURIComponent(key)}/runs`,
      { input },
      signal,
    ),
}
