import { api, apiEvents, ApiError } from '../api/client'
import type { ChatEvent } from '../chat/api'

export type RunKind = 'workflow' | 'chat'

export type RunStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'aborted' | 'interrupted'

export const ACTIVE_STATUSES: RunStatus[] = ['queued', 'running', 'waiting']

export const isActive = (status: RunStatus) => ACTIVE_STATUSES.includes(status)

/** Why a queued run hasn't started yet. */
export type WaitReason =
  | { code: 'instance' }
  | { code: 'user' }
  | { code: 'project' }
  | { code: 'rateLimit'; until: string }

/** What a running run is doing: its step and its last action. */
export interface RunActivity {
  step: { index: number; agent: string } | null
  last: string | null
}

export interface StepResult {
  agent: string
  output: string
  isError: boolean
  complete?: boolean
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
  agent: string | null
  model: string | null
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
  | { type: 'step'; index: number; agent: string }
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
async function* reconnecting<T>(
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
