import type { WaitReason } from './run-types.js';

export interface RunLimits {
  /** Runs executing in the whole instance, chat and workflows together. */
  concurrent: number;
  workflowsPerUser: number;
  chatsPerUser: number;
  /** Workflows that may write executing in one project. */
  writersPerProject: number;
  queuedPerUser: number;
}

/** What the scheduler needs to know about a run. */
export interface RunSlot {
  userId: number;
  projectId: number;
  kind: string;
  writes: boolean;
}

/**
 * Why `run` can't start next to `running`, or null when it can. Only
 * workflows count for the project limit: they run unattended, while a chat is
 * followed by the user, who decides whether two conversations write at once.
 */
export function blockedBy(
  run: RunSlot,
  running: RunSlot[],
  limits: RunLimits,
): WaitReason | null {
  if (running.length >= limits.concurrent) return { code: 'instance' };
  const mine = running.filter((r) => r.userId === run.userId);
  const perUser =
    run.kind === 'chat' ? limits.chatsPerUser : limits.workflowsPerUser;
  if (mine.filter((r) => r.kind === run.kind).length >= perUser) {
    return { code: 'user' };
  }
  const writer = (r: RunSlot) => r.kind === 'workflow' && r.writes;
  if (
    writer(run) &&
    running.filter((r) => r.projectId === run.projectId && writer(r)).length >=
      limits.writersPerProject
  ) {
    return { code: 'project' };
  }
  return null;
}

interface RateLimitWindow {
  resetsAt: string | null;
  status: string | null;
}

/**
 * When a provider's plan limit, as last reported, lets runs start again; null
 * when it isn't exhausted or the reset is already past.
 */
export function rateLimitedUntil(
  snapshot: unknown,
  now = new Date(),
): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const { status, windows } = snapshot as {
    status?: string;
    windows?: Record<string, RateLimitWindow>;
  };
  if (status !== 'rejected') return null;
  const resets = Object.values(windows ?? {})
    .filter((w) => w.status === 'rejected' && w.resetsAt)
    .map((w) => w.resetsAt!)
    .sort();
  const until = resets.at(-1);
  return until && new Date(until) > now ? until : null;
}
