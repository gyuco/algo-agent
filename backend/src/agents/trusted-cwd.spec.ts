import { BadRequestException } from '@nestjs/common';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trustedWorktreeCwd } from './trusted-cwd.js';

describe('trustedWorktreeCwd', () => {
  it('accepts a worktree of that project, resolving symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'algo-cwd-'));
    const tree = join(root, 'worktrees', '2', '7', 'main');
    await mkdir(tree, { recursive: true });
    try {
      await expect(trustedWorktreeCwd(root, 2, tree)).resolves.toContain(
        join('worktrees', '2', '7', 'main'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a folder outside the project worktrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'algo-cwd-'));
    const other = join(root, 'elsewhere');
    await mkdir(other, { recursive: true });
    try {
      await expect(trustedWorktreeCwd(root, 2, other)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        trustedWorktreeCwd(root, 2, join(root, 'worktrees', '3', 'main')),
      ).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a symlink that leaves the worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'algo-cwd-'));
    const outside = await mkdtemp(join(tmpdir(), 'algo-outside-'));
    const tree = join(root, 'worktrees', '2');
    await mkdir(tree, { recursive: true });
    const link = join(tree, 'escape');
    await symlink(outside, link);
    try {
      await expect(trustedWorktreeCwd(root, 2, link)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
