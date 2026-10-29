import type { MissionTask } from '../generated/prisma/client.js';
import { canonicalJson, planTasks, type Plan } from './plan-schema.js';

/** What a proposed plan changes, and whether the user must approve it. */
export interface PlanChanges {
  /** A change the rules never allow: the agent gets the errors back. */
  errors: string[];
  /** A change only the user may make: approve the new version or comment it. */
  requiresUser: boolean;
  changes: {
    addedTasks: string[];
    removedTasks: string[];
    changedTasks: string[];
    addedMilestones: string[];
    sections: string[];
  };
  /** Tasks added to the milestone just reviewed: they fix what it left behind. */
  corrective: string[];
}

/** Task states whose plan entry may never change. */
const FROZEN = ['running', 'ready', 'merging', 'review', 'scope', 'done', 'skipped'];

const SECTIONS = ['scope', 'checks', 'team', 'budget'] as const;

function taskMap(plan: Plan) {
  return new Map(planTasks(plan).map((task) => [task.key, task]));
}

/**
 * §5.5: what `update_plan` may change. A task already run, or being run, keeps
 * its key, criteria and template; pending tasks of milestones not started may
 * change freely; the milestone just reviewed only takes extra tasks.
 */
export function planChanges(
  approved: Plan,
  proposed: Plan,
  tasks: Pick<MissionTask, 'key' | 'status'>[],
  reviewedMilestones: string[] = [],
): PlanChanges {
  const errors: string[] = [];
  const before = taskMap(approved);
  const after = taskMap(proposed);
  const status = new Map(tasks.map((task) => [task.key, task.status]));
  const lastReviewed = reviewedMilestones.at(-1) ?? null;
  const reviewed = new Set(reviewedMilestones);

  // Milestones: no removal, no reordering; new ones only after the last.
  const beforeMilestones = approved.milestones.map((m) => m.id);
  const afterMilestones = proposed.milestones.map((m) => m.id);
  if (
    afterMilestones.length < beforeMilestones.length ||
    beforeMilestones.some((id, i) => afterMilestones[i] !== id)
  ) {
    errors.push('milestones: le milestone esistenti non si tolgono e non si riordinano');
  }
  const addedMilestones = afterMilestones.slice(beforeMilestones.length);

  const addedTasks: string[] = [];
  const removedTasks: string[] = [];
  const changedTasks: string[] = [];
  const corrective: string[] = [];
  const milestoneOf = new Map(
    proposed.milestones.flatMap((m) => m.tasks.map((t) => [t.key, m.id] as const)),
  );

  for (const [key, old] of before) {
    const next = after.get(key);
    if (!next) {
      if (FROZEN.includes(status.get(key) ?? 'pending')) {
        errors.push(`tasks.${key}: un task già eseguito non si toglie`);
      } else {
        removedTasks.push(key);
      }
      continue;
    }
    if (canonicalJson(old) !== canonicalJson(next)) {
      if (FROZEN.includes(status.get(key) ?? 'pending')) {
        errors.push(
          `tasks.${key}: chiavi, criteri, template e dipendenze di un task già eseguito non cambiano`,
        );
      }
      changedTasks.push(key);
    }
  }

  for (const key of after.keys()) {
    if (before.has(key)) continue;
    addedTasks.push(key);
    const milestone = milestoneOf.get(key)!;
    if (reviewed.has(milestone)) {
      if (milestone !== lastReviewed) {
        errors.push(
          `tasks.${key}: una milestone già rivista accetta nuovi task solo se è l'ultima chiusa`,
        );
      } else {
        corrective.push(key);
      }
    }
  }

  // A reviewed milestone keeps its tasks and title: only the correction above may add some.
  for (const milestone of approved.milestones) {
    if (!reviewed.has(milestone.id)) continue;
    const next = proposed.milestones.find((m) => m.id === milestone.id);
    if (!next) continue;
    if (canonicalJson(milestone.title ?? null) !== canonicalJson(next.title ?? null)) {
      errors.push(`milestones.${milestone.id}: una milestone già rivista non cambia titolo`);
    }
    const kept = new Set(next.tasks.map((t) => t.key));
    for (const task of milestone.tasks) {
      if (!kept.has(task.key)) {
        errors.push(`milestones.${milestone.id}: un task di una milestone già rivista non si toglie`);
      }
    }
  }

  const sections = SECTIONS.filter(
    (name) => canonicalJson(approved[name]) !== canonicalJson(proposed[name]),
  );

  const usedTemplates = new Set([...before.values()].map((t) => t.template));
  const newTemplate = [...after.values()].some(
    (t) => !usedTemplates.has(t.template),
  );

  return {
    errors,
    requiresUser: sections.length > 0 || newTemplate,
    changes: { addedTasks, removedTasks, changedTasks, addedMilestones, sections },
    corrective,
  };
}
