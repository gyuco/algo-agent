import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitService } from './git-service.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

const service = new GitService({ get: () => undefined } as never);

async function repository(branch = 'main') {
  const dir = await mkdtemp(join(tmpdir(), 'algo-git-'));
  git(dir, 'init', '-b', branch);
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  await writeFile(join(dir, 'file.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') };
}

async function worktree() {
  const parent = await mkdtemp(join(tmpdir(), 'algo-wt-'));
  return join(parent, 'tree');
}

describe('GitService', () => {
  describe('baseRef', () => {
    it('uses origin/<branch> when there is a remote', async () => {
      const bare = await mkdtemp(join(tmpdir(), 'algo-bare-'));
      git(bare, 'init', '--bare', '-b', 'main');
      const { dir } = await repository();
      git(dir, 'remote', 'add', 'origin', bare);
      git(dir, 'push', '-u', 'origin', 'main');
      git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');

      const base = await service.baseRef(dir, 'main');
      expect(base).toEqual({ ref: 'refs/remotes/origin/main', fetched: true });
      expect(await service.hasOrigin(dir)).toBe(true);
    });

    it('uses the local branch without an origin', async () => {
      const { dir } = await repository();
      await expect(service.baseRef(dir, 'main')).resolves.toEqual({
        ref: 'refs/heads/main',
        fetched: false,
      });
      expect(await service.baseRef(dir, 'nope')).toEqual({
        ref: null,
        fetched: false,
      });
    });

    it('keeps a remote ref already here when the fetch fails', async () => {
      const { dir, commit } = await repository();
      git(
        dir,
        'remote',
        'add',
        'origin',
        join(tmpdir(), 'algo-missing-remote'),
      );
      git(dir, 'update-ref', 'refs/remotes/origin/main', commit);

      const base = await service.baseRef(dir, 'main');
      expect(base.ref).toBe('refs/remotes/origin/main');
      expect(base.fetched).toBe(false);
      expect(base.warning).toBeTruthy();
    });
  });

  it('spots a remote URL that carries credentials', async () => {
    const { dir } = await repository();
    expect(await service.remoteHasCredentials(dir)).toBe(false);
    git(dir, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
    expect(await service.remoteHasCredentials(dir)).toBe(false);
    git(dir, 'remote', 'set-url', 'origin', 'https://u:p@host/r.git');
    expect(await service.remoteHasCredentials(dir)).toBe(true);
    git(dir, 'remote', 'set-url', 'origin', 'https://host/r.git');
    expect(await service.remoteHasCredentials(dir)).toBe(false);
  });

  it('runs git without a shell and knows the ref format', async () => {    const { dir } = await repository();
    expect(await service.isRepository(dir)).toBe(true);
    expect(await service.checkRefFormat(dir, 'feature/x')).toBe(true);
    expect(await service.checkRefFormat(dir, 'a..b')).toBe(false);
  });

  it('creates a branch and a worktree idempotently', async () => {
    const { dir, commit } = await repository();
    const branch = 'mission/7-login';
    const tree = await worktree();

    await service.createBranch(dir, branch, commit);
    await service.createBranch(dir, branch, commit);
    await service.addWorktree(dir, tree, branch);
    await service.addWorktree(dir, tree, branch);

    expect(git(tree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(commit);

    await service.removeWorktree(dir, tree);
    await service.deleteBranch(dir, branch);
    expect(await service.branchExists(dir, branch)).toBe(false);
  });

  it('commits with the trailers and does not run repository hooks', async () => {
    const { dir, commit } = await repository();
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    await writeFile(
      hook,
      '#!/bin/sh\ntouch "$(git rev-parse --show-toplevel)/hook-ran"\n',
      {
        mode: 0o755,
      },
    );

    await service.createBranch(dir, 'mission/7-login', commit);
    const tree = await worktree();
    await service.addWorktree(dir, tree, 'mission/7-login');
    await writeFile(join(tree, 'file.txt'), 'changed\n');

    expect(
      await service.commitAll(tree, 'Login', { Mission: '7', Task: 'login' }),
    ).toBe(true);
    const message = git(tree, 'log', '-1', '--format=%B');
    expect(message).toContain('Mission: 7');
    expect(message).toContain('Task: login');
    expect(existsSync(join(tree, 'hook-ran'))).toBe(false);
    // Nothing staged: no empty commit.
    expect(await service.commitAll(tree, 'again', {})).toBe(false);
  });

  it('merges cleanly, then detects and aborts a conflict', async () => {
    const { dir, commit } = await repository();
    await service.createBranch(dir, 'a', commit);
    await service.createBranch(dir, 'b', commit);
    const treeA = await worktree();
    const treeB = await worktree();
    await service.addWorktree(dir, treeA, 'a');
    await service.addWorktree(dir, treeB, 'b');

    await writeFile(join(treeA, 'other.txt'), 'a\n');
    await service.commitAll(treeA, 'A', {});
    await service.merge(treeA, 'b');
    expect(await service.conflicts(treeA)).toEqual([]);

    await writeFile(join(treeA, 'file.txt'), 'from a\n');
    await service.commitAll(treeA, 'A2', {});
    await writeFile(join(treeB, 'file.txt'), 'from b\n');
    await service.commitAll(treeB, 'B2', {});

    await expect(service.merge(treeA, 'b')).rejects.toThrow();
    expect(await service.conflicts(treeA)).toContain('file.txt');
    await service.abortMerge(treeA);
    expect(await service.conflicts(treeA)).toEqual([]);
  });

  it('resets a worktree and counts how far ahead it is', async () => {
    const { dir, commit } = await repository();
    const tree = await worktree();
    await service.createBranch(dir, 'a', commit);
    await service.addWorktree(dir, tree, 'a');

    await writeFile(join(tree, 'file.txt'), 'work\n');
    await writeFile(join(tree, 'untracked.txt'), 'x\n');
    await service.commitAll(tree, 'work', {});
    expect(await service.aheadOf(tree, commit)).toBe(1);

    await service.resetTo(tree, commit);
    expect(await service.aheadOf(tree, commit)).toBe(0);
    expect(await readFile(join(tree, 'file.txt'), 'utf8')).toBe('base\n');
    expect(existsSync(join(tree, 'untracked.txt'))).toBe(false);
  });

  it('reads a file at a revision and lists untracked files in the diff', async () => {
    const { dir, commit } = await repository();
    const tree = await worktree();
    await service.createBranch(dir, 'a', commit);
    await service.addWorktree(dir, tree, 'a');

    await writeFile(join(tree, 'new.txt'), 'n\n');
    const entries = await service.diff(tree, commit);
    expect(entries).toEqual([{ status: 'A', file: 'new.txt' }]);
    expect(await service.showFile(tree, commit, 'file.txt')).toBe('base\n');
    expect(await service.showFile(tree, commit, 'missing.txt')).toBeNull();
    expect(await service.commonGitDir(tree)).toBe(
      await realpath(join(dir, '.git')),
    );
  });
});
