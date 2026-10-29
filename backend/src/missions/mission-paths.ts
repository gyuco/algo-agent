import { join } from 'node:path';
import { realpath } from 'node:fs/promises';

const MAX_SLUG = 40;

/** The title as a branch name: lowercase, dashes, at most 40 characters. */
export function missionSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return slug || 'mission';
}

/** `mission/<id>-<slug>`, saved on the mission. */
export function missionBranchName(id: number, title: string) {
  return `mission/${id}-${missionSlug(title)}`;
}

/** `<DATA_DIR>/worktrees/<projectId>/<missionId>/main`. */
export function missionWorktreePath(
  dataDir: string,
  projectId: number,
  missionId: number,
) {
  return join(
    dataDir,
    'worktrees',
    String(projectId),
    String(missionId),
    'main',
  );
}

/** `mission/<id>/<task key>`: a task's branch, merged into the mission's. */
export function taskBranchName(missionId: number, key: string) {
  return `mission/${missionId}/${key}`;
}

/** `<DATA_DIR>/worktrees/<projectId>/<missionId>/<key>`. */
export function taskWorktreePath(
  dataDir: string,
  projectId: number,
  missionId: number,
  key: string,
) {
  return join(
    dataDir,
    'worktrees',
    String(projectId),
    String(missionId),
    key,
  );
}

/** The folder all worktrees of a project live in. */
export function projectWorktreesDir(dataDir: string, projectId: number) {
  return join(dataDir, 'worktrees', String(projectId));
}

/** Marks a worktree whose `setup` already ran, outside the worktree. */
export function setupMarker(worktree: string) {
  return `${worktree}.setup.json`;
}

/** The same path with symlinks followed; the path itself when it doesn't exist. */
export async function realPath(path: string) {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
