import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchExists, resolveBaseBranch } from './git-read.js';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

async function repository(branch = 'main') {
  const dir = await mkdtemp(join(tmpdir(), 'algo-missions-'));
  git(dir, 'init', '-b', branch);
  git(dir, 'commit', '--allow-empty', '-m', 'init');
  return dir;
}

describe('git-read', () => {
  it('returns null outside a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'algo-missions-'));
    expect(await resolveBaseBranch(dir)).toBeNull();
  });

  it('prefers develop, then origin/HEAD, then the current branch', async () => {
    const repo = await repository('main');
    expect(await resolveBaseBranch(repo)).toBe('main');

    git(repo, 'branch', 'develop');
    expect(await resolveBaseBranch(repo)).toBe('develop');

    git(repo, 'branch', '-D', 'develop');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    expect(await resolveBaseBranch(repo)).toBe('main');
  });

  it('sees a develop that exists only on origin', async () => {
    const repo = await repository('main');
    git(repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    expect(await branchExists(repo, 'develop')).toBe(true);
    expect(await resolveBaseBranch(repo)).toBe('develop');
  });

  it('tells a missing branch from an existing one', async () => {
    const repo = await repository('main');
    expect(await branchExists(repo, 'main')).toBe(true);
    expect(await branchExists(repo, 'nope')).toBe(false);
  });
});
