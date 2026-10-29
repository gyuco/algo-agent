import { api, apiEvents, tokenStore } from '../api/client'
import type { Attachment } from '../chat/attachments'
import { reconnecting } from '../runs/api'

export type MissionStatus =
  | 'briefing'
  | 'planned'
  | 'approved'
  | 'running'
  | 'paused'
  | 'waiting'
  | 'integrating'
  | 'done'
  | 'aborted'
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'review'
  | 'ready'
  | 'merging'
  | 'scope'
  | 'done'
  | 'blocked'
  | 'skipped'
  | 'aborted'
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
    /** Files a task may delete. */
    deletions: string[]
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
  budget: { fiveHourMinRemaining: number; weeklyMaxShare: number; maxUsd?: number }
  parallelTasks: number
  milestones: PlanMilestone[]
}

/** The mission's budget figures, as GET /missions/:id returns them. */
export interface BudgetView {
  source: 'plan' | 'api_key' | 'none'
  observedAt: string | null
  fiveHour?: { used: number; threshold: number; resetsAt: string }
  week?: {
    used: number
    resetsAt: string
    missionUsed: number
    missionAllowance: number
    globalUsed: number
    globalCap: number
  }
  usd: { spent: number; allowance?: number }
  estimate: true
}

export interface MissionBudgetOverview {
  observedAt: string | null
  fiveHour?: { used: number; resetsAt: string }
  week?: { used: number; resetsAt: string; globalUsed: number; globalCap: number }
  estimate: true
  missions: {
    id: number
    title: string
    status: MissionStatus
    wait: { code?: string; scope?: string; until?: string } | null
    budget: {
      weekly: { used: number; allowance: number }
      usd: { spent: number; allowance?: number }
    }
  }[]
}

export interface Mission {
  id: number
  /** Null while a new project exists only as a briefing (phase 8). */
  projectId: number | null
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
    taskId?: number
    step?: string
    detail?: string
    scope?: 'mission' | 'global'
    window?: string
    until?: string
    planVersion?: number
    previous?: Record<string, unknown>
    violations?: { kind: string; file: string; name?: string }[]
    previousPlan?: Plan
  } | null
  /** On GET /missions/:id: the budget figures for the screen. */
  budget?: BudgetView
  /** On GET /missions/:id: the current milestone, the reviewed ones, the merge queue. */
  progress?: {
    reviewedMilestones: string[]
    currentMilestone: { id: string; title: string } | null
    mergeQueue: number[]
  }
  /** On GET /missions/:id and /tasks: the plan's tasks with their state. */
  tasks?: MissionTask[]
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
  | 'milestone'
  | 'checks'
  | 'checks_started'
  | 'prepare'
  | 'final'

export interface MissionEntry {
  id: number
  missionId: number
  taskId: number | null
  kind: MissionEntryKind
  notify: boolean
  data: Record<string, unknown>
  createdAt: string
}

export interface TaskReport {
  attempt: number
  diff?: {
    files: { path: string; status: string; added: number; removed: number }[]
    added: number
    removed: number
  }
  checks: unknown[]
  review: { verdict: string; output: string } | null
  iterations: number
  warnings: string[]
  costUsd: number
  blocked?: { reason: 'attempts' | 'test_errati' | 'error' | 'config' | 'merge'; detail: string }
  violations?: { kind: 'dependency' | 'migration' | 'deleted' | 'path'; file: string; name?: string }[]
  summary: string
  previous?: { diff: string; review: string }
}

export interface MissionTask {
  id: number
  key: string
  milestone: string
  title: string
  status: TaskStatus
  attempts: number
  runId: number | null
  startedAt: string | null
  finishedAt: string | null
  report: TaskReport | null
  waitingOn: string[]
}

export interface MissionTaskRun {
  id: number
  status: string
  startedAt: string | null
  finishedAt: string | null
  costUsd: number
  error: string | null
  steps: import('../runs/api').StepResult[]
}

export interface MissionTaskDetail extends MissionTask {
  missionId: number
  branch: string | null
  taskBase: string | null
  runs: MissionTaskRun[]
}

export interface CreateNewProject extends CreateMission {
  name: string
  forge: 'github' | 'gitlab'
  namespace?: string
  visibility: 'private' | 'internal' | 'public'
}

export interface CreateMission {
  input: string
  mode: MissionMode
  orchestratorModel: OrchestratorModel
  attachments?: Attachment[]
  fromSession?: string
}

/** One mission in Richiedono te or In corso. */
export interface MissionCard {
  id: number
  title: string
  projectId: number
  projectName: string
  status: MissionStatus
  mode: MissionMode
  wait: { code?: string; taskId?: number; detail?: string; scope?: string; until?: string } | null
  milestone: { id: string; title: string; done: number; total: number } | null
  activeTasks: { key: string; step?: string; last?: string }[]
  budget: BudgetView
  unread: boolean
}

export interface MissionActivity {
  waiting: MissionCard[]
  running: MissionCard[]
  unread: number
}

export const missionsApi = {
  list: (query: { projectId?: number; status?: string; unread?: boolean } = {}) => {
    const params = new URLSearchParams()
    if (query.projectId !== undefined) params.set('projectId', String(query.projectId))
    if (query.status) params.set('status', query.status)
    if (query.unread) params.set('unread', 'true')
    const qs = params.toString()
    return api<Mission[]>(`/missions${qs ? `?${qs}` : ''}`)
  },
  get: (id: number) => api<Mission>(`/missions/${id}`),
  seen: (id: number) => api<{ seenAt: string }>(`/missions/${id}/seen`, { method: 'POST' }),
  activity: () => api<MissionActivity>('/missions/activity'),
  setMode: (id: number, mode: MissionMode) =>
    api<Mission>(`/missions/${id}/mode`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  setTeamModels: (id: number, models: { roles?: Record<string, string>; custom?: Record<string, string> }) =>
    api<Mission>(`/missions/${id}/team`, {
      method: 'POST',
      body: JSON.stringify(models),
    }),
  acceptScope: (id: number) => api<Mission>(`/missions/${id}/scope/accept`, { method: 'POST' }),
  retryPublish: (id: number) => api<Mission>(`/missions/${id}/publish/retry`, { method: 'POST' }),
  entries: (id: number) => api<MissionEntry[]>(`/missions/${id}/entries`),
  create: (projectId: number, body: CreateMission) =>
    api<Mission>(`/projects/${projectId}/missions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createNewProject: (body: CreateNewProject) =>
    api<Mission>('/missions/new-project', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  messages: (id: number, body: { text: string; attachments?: Attachment[] }) =>
    api<{ runId: number }>(`/missions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  approve: (
    id: number,
    body: {
      planVersion: number
      mode: MissionMode
      budget?: { fiveHourMinRemaining: number; weeklyMaxShare: number; maxUsd?: number }
    },
  ) =>
    api<Mission>(`/missions/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  continueBudget: (id: number) =>
    api<Mission>(`/missions/${id}/continue`, { method: 'POST' }),
  budgetOverview: () => api<MissionBudgetOverview>('/missions/budget'),
  retryBaseline: (id: number) =>
    api<Mission>(`/missions/${id}/baseline/retry`, { method: 'POST' }),
  revise: (id: number) =>
    api<Mission>(`/missions/${id}/revise`, { method: 'POST' }),
  abort: (id: number) =>
    api<Mission>(`/missions/${id}/abort`, { method: 'POST' }),
  resume: (id: number) =>
    api<Mission>(`/missions/${id}/resume`, { method: 'POST' }),
  remove: (id: number) =>
    api<void>(`/missions/${id}`, { method: 'DELETE' }),

  tasks: (id: number) => api<{ tasks: MissionTask[] }>(`/missions/${id}/tasks`),
  task: (id: number, key: string) =>
    api<MissionTaskDetail>(`/missions/${id}/tasks/${key}`),
  /** The current attempt's unified diff, as text. */
  taskDiff: async (id: number, key: string) => {
    const token = tokenStore.get()
    const response = await fetch(`/api/missions/${id}/tasks/${key}/diff`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!response.ok) throw new Error(await response.text())
    return response.text()
  },
  taskOk: (id: number, key: string) =>
    api<Mission>(`/missions/${id}/tasks/${key}/ok`, { method: 'POST' }),
  taskRedo: (id: number, key: string, note: string) =>
    api<Mission>(`/missions/${id}/tasks/${key}/redo`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  taskSkip: (id: number, key: string) =>
    api<Mission>(`/missions/${id}/tasks/${key}/skip`, { method: 'POST' }),
  retryFinalChecks: (id: number) =>
    api<Mission>(`/missions/${id}/final-checks/retry`, { method: 'POST' }),

  /** The mission's log after `after`, then live entries, reconnecting on its own. */
  events(id: number, signal: AbortSignal, after = 0): AsyncGenerator<MissionEntry> {
    let cursor = after
    return reconnecting<MissionEntry>(
      () => apiEvents<MissionEntry>(`/missions/${id}/events?after=${cursor}`, signal),
      signal,
      (seq) => (cursor = seq),
    )
  },

  /** §7.1: the entries of every mission of the user, for notifications. */
  activeEvents(signal: AbortSignal, after = 0): AsyncGenerator<MissionEntry> {
    let cursor = after
    return reconnecting<MissionEntry>(
      () => apiEvents<MissionEntry>(`/missions/active/events?after=${cursor}`, signal),
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
  paused: 'missions.status.paused',
  waiting: 'missions.status.waiting',
  integrating: 'missions.status.integrating',
  done: 'missions.status.done',
  aborted: 'missions.status.aborted',
} as const

export const TASK_STATUS_KEY = {
  pending: 'missions.task.pending',
  running: 'missions.task.running',
  review: 'missions.task.review',
  ready: 'missions.task.ready',
  merging: 'missions.task.merging',
  scope: 'missions.task.scope',
  done: 'missions.task.done',
  blocked: 'missions.task.blocked',
  skipped: 'missions.task.skipped',
  aborted: 'missions.task.aborted',
} as const
