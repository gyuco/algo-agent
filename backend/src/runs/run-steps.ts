import type { CommandOutcome } from './graph-engine.js';

export type StepStatus =
  | 'pending'
  | 'waiting_approval'
  | 'running'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'aborted';

/** One workflow step of a run, as kept in `stepsJson`. */
export interface StepResult {
  agent: string;
  status: StepStatus;
  output: string;
  costUsd: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** Steps that need approval: the prompt as it will run, and whether the agent may write files. */
  prompt?: string;
  writes?: boolean;
  /** When the step asked for approval, and when it got it. */
  requestedAt?: string;
  approvedAt?: string;
  /** Why the user rejected it, if they said. */
  note?: string;
  /** The value its answer ended with, for steps that declare verdicts. */
  verdict?: string;
  /** A step that repeats: each round so far, the step then its check. */
  iterations?: Iteration[];
  /** A step with `run`: the commands' outcome, output included. */
  commands?: CommandOutcome;
  /** A verification: its verdict and the text it was given. */
  review?: { verdict: string; output: string };
  /** The commit of the checkpoint after a writing step. */
  checkpoint?: string;
  /** The verdict of a repeat's check that stopped the block. */
  stopVerdict?: string;
  /** Something to know about how it ended, e.g. a repeat that ran out of rounds. */
  warning?: string;
  /** Why the step failed, e.g. the error its agent's provider gave. */
  error?: string;
}

/** One round of a step that repeats. */
export interface Iteration {
  output: string;
  verdict?: string;
  costUsd: number;
  check: { output: string; verdict: string; costUsd: number };
}

/** A run's steps by id; steps that never started are missing. */
export type StepResults = Record<string, StepResult>;

/** A step as runs saved it before steps had ids: a list in order. */
interface LegacyStep {
  agent: string;
  output: string;
  isError: boolean;
  complete?: boolean;
}

/** Reads `stepsJson`; a list from older runs becomes `step-<n>`, the ids those steps have now. */
export function readSteps(json: string): StepResults {
  const data = JSON.parse(json) as StepResults | LegacyStep[];
  if (!Array.isArray(data)) return data;
  return Object.fromEntries(
    data.map((s, i): [string, StepResult] => [
      `step-${i + 1}`,
      {
        agent: s.agent,
        status: s.isError
          ? 'failed'
          : s.complete === false
            ? 'aborted'
            : 'done',
        output: s.output,
        costUsd: 0,
        startedAt: null,
        finishedAt: null,
      },
    ]),
  );
}

/** The steps as a list for the API, in the order they started. */
export function listSteps(steps: StepResults) {
  return Object.entries(steps)
    .map(([id, step], index) => ({ id, index, ...step }))
    .sort(
      (a, b) =>
        (a.startedAt ?? '').localeCompare(b.startedAt ?? '') ||
        a.index - b.index,
    )
    .map(({ index: _index, ...step }) => step);
}
