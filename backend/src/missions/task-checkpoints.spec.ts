import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitService } from './git-service.js';
import {
  checkpoint,
  matchesScope,
  protectedFiles,
  squash,
} from './task-checkpoints.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

let root = '';
let service: GitService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'algo-checkpoints-'));
  await mkdir(join(root, 'tests'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'tests', 'a.spec.ts'), 'expect(1)\n');
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'base');
  service = new GitService({ get: () => undefined } as never);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('task checkpoints', () => {
  it('commits a checkpoint only when something changed', async () => {
    await writeFile(join(root, 'tests', 'a.spec.ts'), 'expect(2)\n');
    const first = await checkpoint(service, root, 'tests', 1);
    expect(first).toBeTruthy();
    expect(git(root, 'log', '-1', '--format=%s')).toBe('checkpoint: tests #1');

    const again = await checkpoint(service, root, 'tests', 2);
    expect(again).toBeNull();
  });

  it('protects the files changed up to the checkpoint of the protected step', async () => {
    await writeFile(join(root, 'tests', 'a.spec.ts'), 'expect(2)\n');
    const testsCheckpoint = (await checkpoint(service, root, 'tests', 1))!;
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 2\n');
    await checkpoint(service, root, 'implement', 1);

    const clean = await protectedFiles(
      service,
      root,
      'HEAD~2',
      { tests: { checkpoint: testsCheckpoint } },
      ['tests'],
      [],
    );
    expect(clean).toEqual([]);

    await writeFile(join(root, 'tests', 'a.spec.ts'), 'expect(3)\n');
    const touched = await protectedFiles(
      service,
      root,
      'HEAD~2',
      { tests: { checkpoint: testsCheckpoint } },
      ['tests'],
      ['tests'],
    );
    expect(touched).toEqual(['tests/a.spec.ts']);
  });

  it('protects the plan test files even without a checkpoint', async () => {
    await writeFile(join(root, 'tests', 'a.spec.ts'), 'expect(2)\n');
    const touched = await protectedFiles(
      service,
      root,
      'HEAD',
      {},
      ['tests'],
      ['tests'],
    );
    expect(touched).toEqual(['tests/a.spec.ts']);
  });

  it('goes back to a checkpoint, losing only the step after it', async () => {
    await writeFile(join(root, 'tests', 'a.spec.ts'), 'expect(2)\n');
    const saved = (await checkpoint(service, root, 'tests', 1))!;
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 99\n');

    await service.resetTo(root, saved);

    expect(git(root, 'show', 'HEAD:src/a.ts')).toContain('export const a = 1');
  });

  it('squashes the checkpoints into one commit with the trailers', async () => {
    await writeFile(join(root, 'tests', 'a.spec.ts'), 'expect(2)\n');
    await checkpoint(service, root, 'tests', 1);
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 2\n');
    await checkpoint(service, root, 'implement', 1);
    const base = git(root, 'rev-parse', 'HEAD~2');

    await squash(service, root, base, 'Task A', { Mission: '7', Task: 'a' });

    expect(git(root, 'rev-list', '--count', `${base}..HEAD`)).toBe('1');
    const body = git(root, 'log', '-1', '--format=%B');
    expect(body).toContain('Task A');
    expect(body).toContain('Mission: 7');
    expect(body).toContain('Task: a');
  });
});

describe('matchesScope', () => {
  it('reads scope.tests like the perimeter: ** matches the root too', () => {
    expect(matchesScope('a.spec.ts', ['**/*.spec.ts'])).toBe(true);
    expect(matchesScope('src/x/a.spec.ts', ['**/*.spec.ts'])).toBe(true);
    expect(matchesScope('src/a.ts', ['**/*.spec.ts'])).toBe(false);
    expect(matchesScope('test/fixtures/a.json', ['test/fixtures'])).toBe(true);
  });
});
