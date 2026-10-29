import { api, apiEvents } from '../api/client'
import type { Attachment } from '../chat/attachments'
import { reconnecting } from '../runs/api'

export type MissionStatus = 'briefing' | 'planned' | 'approved' | 'running' | 'waiting' | 'aborted'
export type MissionMode = 'step' | 'auto'
export type OrchestratorModel = 'claude:opus' | 'claude:sonnet'

export interface PlanRole {
  agent: string
  model: string
  maxTurns: number
}

export interface PlanCustomAgent {
  key: string
  description: string
  model: string
  permissions: { files: 'none' | 'read' | 'write'; skills: string[] }
  prompt: string
}

export interface PlanTask {
  key: string
  title?: string
  template: string
  agents: Record<string, string>
  needs: string[]
  acceptance: string[]
}

export interface PlanMilestone {
  id: string
  title?: string
  tasks: PlanTask[]
}

export type PlanCommand = string | { run: string; workdir?: string }

export interface Plan {
  title: string
  goal: string
  baseBranch?: string
  scope: {
    dependencies: string[]
    migrations: boolean
    paths: string[]
    tests: string[]
  }
  checks: {
    setup?: PlanCommand
    build?: PlanCommand
    lint?: PlanCommand
    test: PlanCommand
    /** Appended to `test` by run_checks; carries {{pattern}}. */
    testFilter?: string
    /** Names of vault secrets exposed to the commands. */
    secrets: string[]
    parallel: boolean
    workdir?: string
  }
  team: {
    orchestrator: string
    roles: Record<string, PlanRole>
    custom: PlanCustomAgent[]
  }
  budget: { fiveHourMinRemaining: number; weeklyMaxShare: number }
  parallelTasks: number
  milestones: PlanMilestone[]
}

export interface Mission {
  id: number
  projectId: number
  userId: number
  title: string
  status: MissionStatus
  mode: MissionMode
  input: string
  plan: Plan | null
  planVersion: number
  approvedVersion: number | null
  orchestratorModel: string
  sessionId: string | null
  fromSession: string | null
  baseBranch: string | null
  /** The commit the mission's branch started from. */
  baseCommit: string | null
  branch: string | null
  worktreePath: string | null
  prUrl: string | null
  wait: {
    code: string
    entryId?: number
    runId?: number
    step?: string
    detail?: string
  } | null
  budgetJson: string
  costUsd: number
  createdAt: string
  updatedAt: string
  approvedAt: string | null
  finishedAt: string | null
  seenAt: string | null
  /** Present on GET /missions/:id: why the approved plan can no longer be approved. */
  validationErrors?: string[]
  /** Worst-case agent sessions, from the validation. */
  planEstimate?: number
  /** The run of the first turn, on creation. */
  runId?: number
  /** Present on GET /missions/:id: the active preparation, if any. */
  preparation?: { runId: number } | null
}

export type MissionEntryKind =
  | 'status'
  | 'turn'
  | 'question'
  | 'decision'
  | 'wait'
  | 'resume'
  | 'note'
  | 'plan'
  | 'budget'
  | 'pr'
  | 'error'

export interface MissionEntry {
  id: number
  missionId: number
  taskId: number | null
  kind: MissionEntryKind
  notify: boolean
  data: Record<string, unknown>
  createdAt: string
}

export interface CreateMission {
  input: string
  mode: MissionMode
  orchestratorModel: OrchestratorModel
  attachments?: Attachment[]
  fromSession?: string
}

export const missionsApi = {
  list: (query: { projectId?: number; status?: string } = {}) => {
    const params = new URLSearchParams()
    if (query.projectId !== undefined) params.set('projectId', String(query.projectId))
    if (query.status) params.set('status', query.status)
    const qs = params.toString()
    return api<Mission[]>(`/missions${qs ? `?${qs}` : ''}`)
  },
  get: (id: number) => api<Mission>(`/missions/${id}`),
  entries: (id: number) => api<MissionEntry[]>(`/missions/${id}/entries`),
  create: (projectId: number, body: CreateMission) =>
    api<Mission>(`/projects/${projectId}/missions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  messages: (id: number, body: { text: string; attachments?: Attachment[] }) =>
    api<{ runId: number }>(`/missions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  approve: (id: number, body: { planVersion: number; mode: MissionMode }) =>
    api<Mission>(`/missions/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  retryBaseline: (id: number) =>
    api<Mission>(`/missions/${id}/baseline/retry`, { method: 'POST' }),
  revise: (id: number) =>
    api<Mission>(`/missions/${id}/revise`, { method: 'POST' }),
  abort: (id: number) =>
    api<Mission>(`/missions/${id}/abort`, { method: 'POST' }),
  remove: (id: number) =>
    api<void>(`/missions/${id}`, { method: 'DELETE' }),

  /** The mission's log after `after`, then live entries, reconnecting on its own. */
  events(id: number, signal: AbortSignal, after = 0): AsyncGenerator<MissionEntry> {
    let cursor = after
    return reconnecting<MissionEntry>(
      () => apiEvents<MissionEntry>(`/missions/${id}/events?after=${cursor}`, signal),
      signal,
      (seq) => (cursor = seq),
    )
  },

  /** Whether checks can run on this machine: Approve stays off without it. */
  sandbox: () => api<{ available: boolean; reason?: string }>('/system/sandbox'),
}

export const MISSION_STATUS_KEY = {
  briefing: 'missions.status.briefing',
  planned: 'missions.status.planned',
  approved: 'missions.status.approved',
  running: 'missions.status.running',
  waiting: 'missions.status.waiting',
  aborted: 'missions.status.aborted',
} as const
