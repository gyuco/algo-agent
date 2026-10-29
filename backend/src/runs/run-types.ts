import type { Run } from '../generated/prisma/client.js';
import type { CheckName } from '../missions/checks.service.js';
import type { ChatEvent } from '../providers/provider.js';
import type { StepStatus } from './run-steps.js';

export type RunKind =
  | 'workflow'
  | 'chat'
  | 'mission-orchestrator'
  | 'mission-task'
  | 'mission-prepare';

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

/**
 * How a run's own logic says it stopped: ended, or `waiting` for the user with
 * nothing else to do. Aborts and crashes are decided by the executor.
 */
export type RunOutcome = 'done' | 'failed' | 'waiting';

/** What a run emits: a provider event, a workflow step starting or ending, or the run ending. */
export type RunEventData =
  | ChatEvent
  | { type: 'step_started'; id: string; agent: string }
  | { type: 'step_finished'; id: string; status: StepStatus }
  | {
      type: 'iteration_started';
      /** The step running this part of the round: the one that repeats, or its check. */
      id: string;
      agent: string;
      iteration: number;
      max: number;
    }
  | {
      type: 'approval_requested';
      id: string;
      agent: string;
      prompt: string;
      writes: boolean;
    }
  | { type: 'check_output'; name: CheckName; text: string }
  | {
      type: 'prepare_step';
      step: PrepareStep;
      status: 'started' | 'done' | 'failed' | 'skipped';
      detail?: string;
    }
  | { type: 'finished'; status: RunStatus };

/** The steps of a mission's preparation, in the order they run. */
export type PrepareStep =
  'fetch' | 'branch' | 'worktree' | 'setup' | 'build' | 'lint' | 'test';

export type { CheckName };

/** An event as clients receive it: `seq` is the cursor to resume from. */
export interface SequencedEvent {
  seq: number;
  data: RunEventData;
}

/** What a running run is doing, for lists: its step and its last action. */
export interface RunActivity {
  /** Workflow step and its agent; null for chat. */
  step: { id: string; agent: string } | null;
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
   * with the error's message; `signal` fires when the run is stopped. A run
   * that returned `waiting` executes again, on the same log, once it's queued again.
   */
  execute(
    run: Run,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, RunOutcome>;
  /** Queues a new run continuing `run`; the run is already known to be the user's. */
  resume?(run: Run): Promise<{ runId: number }>;
}
