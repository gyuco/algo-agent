import { api, apiEvents, ApiError } from '../api/client'
import type { ChatEvent } from '../chat/api'

export type RunKind =
  | 'workflow'
  | 'chat'
  | 'mission-orchestrator'
  | 'mission-task'
  | 'mission-prepare'

export type RunStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'aborted' | 'interrupted'

export const ACTIVE_STATUSES: RunStatus[] = ['queued', 'running', 'waiting']

export const isActive = (status: RunStatus) => ACTIVE_STATUSES.includes(status)

/** Why a queued run hasn't started yet. */
export type WaitReason =
  | { code: 'instance' }
  | { code: 'user' }
  | { code: 'project' }
  | { code: 'rateLimit'; until: string }

/** The steps of a mission's preparation, in the order they run. */
export type PrepareStep = 'fetch' | 'branch' | 'worktree' | 'setup' | 'build' | 'lint' | 'test'
export type MissionCheckName = 'setup' | 'build' | 'lint' | 'test'

/** What a running run is doing: its step and its last action. */
export interface RunActivity {
  step: { id: string; agent: string } | null
  last: string | null
}

export type StepStatus = 'pending' | 'waiting_approval' | 'running' | 'done' | 'skipped' | 'failed' | 'aborted'

/** A workflow step of a run; the list is in the order steps started. */
export interface StepResult {
  id: string
  agent: string
  status: StepStatus
  output: string
  costUsd: number
  startedAt: string | null
  finishedAt: string | null
  /** Steps that need approval: the prompt as it will run, and whether the agent may write files. */
  prompt?: string
  writes?: boolean
  requestedAt?: string
  approvedAt?: string
  /** Why the user rejected it. */
  note?: string
  /** The value its answer ended with, for steps that declare verdicts. */
  verdict?: string
  /** A step that repeats: each round so far, the step then its check. */
  iterations?: { output: string; verdict?: string; costUsd: number; check: { output: string; verdict: string; costUsd: number } }[]
  /** A step with run: the commands' outcome. */
  commands?: {
    ok: boolean
    results: {
      name: MissionCheckName
      argv: string[]
      ok: boolean
      exitCode: number | null
      timedOut: boolean
      durationMs: number
      output: string
    }[]
  }
  /** A verification: its verdict and the text it was given. */
  review?: { verdict: string; output: string }
  /** The commit of the checkpoint after a writing step. */
  checkpoint?: string
  /** The verdict of a repeat's check that stopped the block. */
  stopVerdict?: string
  warning?: string
}

export interface Run {
  id: number
  kind: RunKind
  projectId: number
  projectName: string | null
  status: RunStatus
  trigger: string
  title: string
  input: string
  workflow: string | null
  sessionId: string | null
  missionId: number | null
  missionTaskId: number | null
  agent: string | null
  model: string | null
  effort: string | null
  provider: string | null
  writes: boolean
  steps: StepResult[]
  costUsd: number
  error: string | null
  resumeOf: number | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  seenAt: string | null
  reason: WaitReason | null
  activity: RunActivity | null
  unread: boolean
}

export type RunEvent =
  | ChatEvent
  | { type: 'step_started'; id: string; agent: string }
  | { type: 'step_finished'; id: string; status: StepStatus }
  | { type: 'approval_requested'; id: string; agent: string; prompt: string; writes: boolean }
  /** A round of a repeat begins: `id` is the step running this part, the one that repeats or its check. */
  | { type: 'iteration_started'; id: string; agent: string; iteration: number; max: number }
  /** Logged by runs from before steps had ids. */
  | { type: 'step'; index: number; agent: string }
  /** A mission's preparation: a step starting or ending. */
  | {
      type: 'prepare_step'
      step: PrepareStep
      status: 'started' | 'done' | 'failed' | 'skipped'
      detail?: string
    }
  /** Live output of a preparation command, already masked. */
  | { type: 'check_output'; name: MissionCheckName; text: string }
  | {
      type: 'commands_finished'
      id: string
      ok: boolean
      results: { name: string; ok: boolean; exitCode: number | null; timedOut: boolean; durationMs: number }[]
    }
  | { type: 'protect_violation'; id: string; files: string[] }
  | { type: 'scope_violation'; id: string; violations: { kind: string; file: string; name?: string }[] }
  | { type: 'finished'; status: RunStatus }

/** What the user's activity stream sends. */
export type RunNotice =
  /** Sent on every (re)connection: what changed while away isn't resent, so reload. */
  | { type: 'ready' }
  | { type: 'run'; run: Run }
  | { type: 'activity'; runId: number; activity: RunActivity }

const MAX_BACKOFF_MS = 10_000

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })
}

/**
 * Yields what `open(cursor)` streams, opening it again after a dropped
 * connection, with growing pauses, until `ended` says so or `signal` fires.
 * A 4xx answer is final and thrown.
 */
export async function* reconnecting<T>(
  open: () => AsyncGenerator<{ id: number | null; data: T }>,
  signal: AbortSignal,
  onId: (id: number) => void = () => undefined,
  ended: (data: T) => boolean = () => false,
): AsyncGenerator<T> {
  let backoff = 500
  while (!signal.aborted) {
    try {
      for await (const event of open()) {
        backoff = 500
        if (event.id !== null) onId(event.id)
        yield event.data
        if (ended(event.data)) return
      }
    } catch (err) {
      if (signal.aborted) return
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) throw err
    }
    await wait(backoff, signal)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }
}

export const runsApi = {
  get: (id: number) => api<Run>(`/runs/${id}`),
  active: () => api<Run[]>('/runs/active'),
  abort: (id: number) => api<void>(`/runs/${id}/abort`, { method: 'POST' }),
  resume: (id: number) => api<{ runId: number }>(`/runs/${id}/resume`, { method: 'POST' }),
  seen: (id: number) => api<void>(`/runs/${id}/seen`, { method: 'POST' }),
  approve: (id: number, stepId: string) =>
    api<void>(`/runs/${id}/steps/${encodeURIComponent(stepId)}/approve`, { method: 'POST' }),
  reject: (id: number, stepId: string, note: string) =>
    api<void>(`/runs/${id}/steps/${encodeURIComponent(stepId)}/reject`, {
      method: 'POST',
      body: JSON.stringify(note.trim() ? { note: note.trim() } : {}),
    }),

  /**
   * The run's events from the start (or after `after`), then live ones, until
   * `finished`. Reconnects on its own and resumes right after the last event.
   * Stopping to follow (`signal`) leaves the run going.
   */
  follow(id: number, signal: AbortSignal, after = 0): AsyncGenerator<RunEvent> {
    let cursor = after
    return reconnecting<RunEvent>(
      () => apiEvents<RunEvent>(`/runs/${id}/events?after=${cursor}`, signal),
      signal,
      (seq) => (cursor = seq),
      (event) => event.type === 'finished',
    )
  },

  /** Changes to all the user's runs, for as long as `signal` allows. */
  watch(signal: AbortSignal): AsyncGenerator<RunNotice> {
    return reconnecting<RunNotice>(() => apiEvents<RunNotice>('/runs/active/events', signal), signal)
  },
}
