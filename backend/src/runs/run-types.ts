import type { Run } from '../generated/prisma/client.js';
import type { ChatEvent } from '../providers/provider.js';

export type RunKind = 'workflow' | 'chat';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'interrupted';

/** Statuses a run still has to leave. */
export const ACTIVE_STATUSES: RunStatus[] = ['queued', 'running', 'waiting'];

export const isActive = (status: string) =>
  (ACTIVE_STATUSES as string[]).includes(status);

/** How a run's own logic says it ended; aborts and crashes are decided by the executor. */
export type RunOutcome = 'done' | 'failed';

/** What a run emits: a provider event, a workflow step starting, or the run ending. */
export type RunEventData =
  | ChatEvent
  | { type: 'step'; index: number; agent: string }
  | { type: 'finished'; status: RunStatus };

/** An event as clients receive it: `seq` is the cursor to resume from. */
export interface SequencedEvent {
  seq: number;
  data: RunEventData;
}

/** What a running run is doing, for lists: its step and its last action. */
export interface RunActivity {
  /** Workflow step, from 0, and its agent; null for chat. */
  step: { index: number; agent: string } | null;
  /** Last thing the agent did, e.g. "Edit src/app.ts" or "→ tester". */
  last: string | null;
}

/** Why a queued run hasn't started yet. */
export type WaitReason =
  | { code: 'instance' }
  | { code: 'user' }
  | { code: 'project' }
  | { code: 'rateLimit'; until: string };

/** Runs one kind of run. Workflows and chat register theirs with `RunHandlers`. */
export interface RunHandler {
  /**
   * Re-checks permissions, then yields the run's events. Throwing fails the run
   * with the error's message; `signal` fires when the run is stopped.
   */
  execute(
    run: Run,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, RunOutcome>;
  /** Queues a new run continuing `run`; the run is already known to be the user's. */
  resume?(run: Run): Promise<{ runId: number }>;
}
