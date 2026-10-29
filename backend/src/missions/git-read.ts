import { execFile } from 'node:child_process';

/**
 * Minimal read-only git access for the briefing (phase 1). Phase 2's
 * `GitService` replaces it. Always an array of arguments, never a shell.
 */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: 5_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout.trim()),
    );
  });
}

/** Whether the folder is inside a git work tree. */
export async function isGitRepository(cwd: string) {
  return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
}

/** Whether `branch` exists locally or as `origin/<branch>`. */
export async function branchExists(cwd: string, branch: string) {
  const local = await git(cwd, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
  if (local !== null) return true;
  const remote = await git(cwd, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}`,
  ]);
  return remote !== null;
}

/**
 * The branch a mission will start from: `develop` when it exists, otherwise
 * the remote's default branch, otherwise the current one. Null without git.
 */
export async function resolveBaseBranch(cwd: string): Promise<string | null> {
  if (!(await isGitRepository(cwd))) return null;
  if (await branchExists(cwd, 'develop')) return 'develop';

  const head = await git(cwd, [
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (head) return head.replace(/^origin\//, '');

  return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])) || null;
}
