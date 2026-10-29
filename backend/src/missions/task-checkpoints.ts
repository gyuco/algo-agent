import { GitService } from './git-service.js';
import { matches } from './scope.service.js';

/** The checkpoint commit of a writing step; null when it changed nothing. */
export async function checkpoint(
  git: GitService,
  worktree: string,
  stepId: string,
  round: number,
) {
  const made = await git.commitAll(worktree, `checkpoint: ${stepId} #${round}`);
  return made ? git.revParse(worktree, 'HEAD') : null;
}

/** A path inside one of the plan's patterns: the same matcher as the perimeter. */
export const matchesScope = matches;

/**
 * The files a writer may not change: those changed up to the checkpoint of a
 * protected step, plus the plan's test files, that changed since that checkpoint.
 */
export async function protectedFiles(
  git: GitService,
  worktree: string,
  taskBase: string,
  steps: Record<string, { checkpoint?: string }>,
  protect: string[],
  tests: string[],
) {
  const files = new Set<string>();
  const checkpoints: string[] = [];
  for (const id of protect) {
    const saved = steps[id]?.checkpoint;
    if (!saved) continue;
    checkpoints.push(saved);
    for (const file of await git.changedBetween(worktree, taskBase, saved)) {
      files.add(file);
    }
  }
  const entries = await git.diff(worktree, taskBase);
  for (const entry of entries) {
    if (matchesScope(entry.file, tests)) files.add(entry.file);
  }
  if (!files.size) return [];

  // Without a protected checkpoint the task base is the line: the plan's test
  // files are protected from the first write.
  const baselines = checkpoints.length ? checkpoints : [taskBase];
  const changed = new Set<string>();
  for (const saved of baselines) {
    for (const entry of await git.diff(worktree, saved)) {
      changed.add(entry.file);
    }
  }
  return [...files].filter((file) => changed.has(file));
}

/** The last checkpoint of the steps, or the task's base when none wrote. */
export function lastCheckpoint(
  steps: Record<string, { checkpoint?: string }>,
  taskBase: string,
) {
  return (
    Object.values(steps)
      .map((s) => s.checkpoint)
      .filter((c): c is string => Boolean(c))
      .at(-1) ?? taskBase
  );
}

/** Puts a worktree back to the last checkpoint: a task resumes from there. */
export async function resetToLastCheckpoint(
  git: GitService,
  worktree: string,
  steps: Record<string, { checkpoint?: string }>,
  taskBase: string,
) {
  const checkpoint = lastCheckpoint(steps, taskBase);
  if (checkpoint) await git.resetTo(worktree, checkpoint);
  return checkpoint;
}

/** One commit per task: the checkpoints collapse at the end of an attempt. */
export async function squash(  git: GitService,
  worktree: string,
  taskBase: string,
  title: string,
  trailers: Record<string, string>,
) {
  await git.resetSoft(worktree, taskBase);
  return git.commitAll(worktree, title, trailers);
}
