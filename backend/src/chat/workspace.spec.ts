import { BadRequestException } from '@nestjs/common';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInside, resolveWorkspace } from './workspace.js';

describe('isInside', () => {
  it('accepts the dir and its children', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b/c/d')).toBe(true);
  });

  it('rejects parents, siblings and prefix look-alikes', () => {
    expect(isInside('/a/b', '/a')).toBe(false);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a/b/../c')).toBe(false);
  });
});

describe('resolveWorkspace', () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'ws-root-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'ws-out-')));
    await mkdir(join(root, 'project'));
    await writeFile(join(root, 'file.txt'), 'x');
    await symlink(outside, join(root, 'escape'));
  });

  it('resolves a directory inside the root', async () => {
    await expect(resolveWorkspace(join(root, 'project'), root)).resolves.toBe(
      join(root, 'project'),
    );
  });

  it.each([
    ['relative paths', () => 'project'],
    ['missing paths', () => join(root, 'missing')],
    ['files', () => join(root, 'file.txt')],
    ['paths outside the root', () => outside],
    ['symlinks that escape the root', () => join(root, 'escape')],
  ])('rejects %s', async (_, path) => {
    await expect(resolveWorkspace(path(), root)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
