import type { Mission, MissionTask } from '../generated/prisma/client.js';
import { planTasks, type Plan } from './plan-schema.js';

/** `Mission.progressJson`. */
export interface MissionProgress {
  /** Milestones the orchestrator reviewed and confirmed, in order. */
  reviewedMilestones: string[];
  /** Tasks waiting to be merged, in the order they will be (phase 5, informational). */
  mergeQueue?: number[];
}

export function readProgress(
  mission: Pick<Mission, 'progressJson'>,
): MissionProgress {
  try {
    const value = JSON.parse(mission.progressJson || '{}') as Partial<MissionProgress>;
    return {
      reviewedMilestones: Array.isArray(value.reviewedMilestones)
        ? value.reviewedMilestones.filter((m): m is string => typeof m === 'string')
        : [],
      ...(Array.isArray(value.mergeQueue) ? { mergeQueue: value.mergeQueue } : {}),
    };
  } catch {
    return { reviewedMilestones: [] };
  }
}

export function writeProgress(progress: MissionProgress) {
  return JSON.stringify(progress);
}

const closed = (status: string) => status === 'done' || status === 'skipped';

/**
 * §5.1: the first milestone with a task still open, or not reviewed yet. Tasks
 * of later milestones wait for its review: milestones are barriers.
 */
export function currentMilestone(
  plan: Plan,
  tasks: Pick<MissionTask, 'key' | 'status'>[],
  progress: MissionProgress,
): { id: string; title: string } | null {
  const status = new Map(tasks.map((task) => [task.key, task.status]));
  const reviewed = new Set(progress.reviewedMilestones);
  for (const milestone of plan.milestones) {
    const open = milestone.tasks.some(
      (task) => !closed(status.get(task.key) ?? 'pending'),
    );
    if (open || !reviewed.has(milestone.id)) {
      return { id: milestone.id, title: milestone.title ?? milestone.id };
    }
  }
  return null;
}

/** The tasks of one milestone, in plan order, with their state. */
export function milestoneTasks(
  plan: Plan,
  tasks: MissionTask[],
  milestoneId: string,
) {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const planned = planTasks(plan).filter((task) => task.milestone === milestoneId);
  return planned
    .map((task) => ({ planned: task, row: byKey.get(task.key) }))
    .filter((entry): entry is { planned: (typeof planned)[number]; row: MissionTask } =>
      Boolean(entry.row),
    );
}

/** A task's needs are all done or skipped. */
export function needsMet(
  planned: { needs: string[] },
  status: Map<string, string>,
) {
  return planned.needs.every((key) => closed(status.get(key) ?? 'pending'));
}
