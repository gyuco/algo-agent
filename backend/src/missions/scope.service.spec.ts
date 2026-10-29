import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitService } from './git-service.js';
import { ScopeService } from './scope.service.js';
import type { Plan } from './plan-schema.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

const service = new ScopeService(
  new GitService({ get: () => undefined } as never),
);

const scope = (overrides: Partial<Plan['scope']> = {}): Plan['scope'] => ({
  dependencies: [],
  migrations: false,
  paths: [],
  tests: [],
  ...overrides,
});

async function worktree() {
  const dir = await mkdtemp(join(tmpdir(), 'algo-scope-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'x', dependencies: { old: '1.0.0' } }, null, 2),
  );
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1\n');
  await writeFile(join(dir, 'README.md'), '# x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-b', 'task');
  return { dir, base };
}

async function manifest(dir: string, dependencies: Record<string, string>) {
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'x', dependencies }, null, 2),
  );
}

describe('ScopeService', () => {
  it('reports a new dependency outside the plan, and accepts one inside it', async () => {
    const { dir, base } = await worktree();
    await manifest(dir, { old: '1.0.0', nuovo: '2.0.0' });

    expect(await service.check(dir, base, scope())).toEqual([
      { kind: 'dependency', file: 'package.json', name: 'nuovo' },
    ]);
    expect(
      await service.check(dir, base, scope({ dependencies: ['nuovo'] })),
    ).toEqual([]);
  });

  it('checks devDependencies too', async () => {
    const { dir, base } = await worktree();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'x',
        dependencies: { old: '1.0.0' },
        devDependencies: { vitest: '1' },
      }),
    );
    expect(await service.check(dir, base, scope())).toEqual([
      { kind: 'dependency', file: 'package.json', name: 'vitest' },
    ]);
  });

  it('reports migrations unless the plan allows them', async () => {
    const { dir, base } = await worktree();
    await mkdir(join(dir, 'prisma', 'migrations', '001'), { recursive: true });
    await writeFile(
      join(dir, 'prisma', 'migrations', '001', 'm.sql'),
      '-- x\n',
    );

    expect(await service.check(dir, base, scope())).toContainEqual({
      kind: 'migration',
      file: 'prisma/migrations/001/m.sql',
    });
    expect(await service.check(dir, base, scope({ migrations: true }))).toEqual(
      [],
    );
  });

  it('reports deleted files and files outside the paths', async () => {
    const { dir, base } = await worktree();
    await rm(join(dir, 'README.md'));
    await writeFile(join(dir, 'outside.txt'), 'x\n');

    const violations = await service.check(
      dir,
      base,
      scope({ paths: ['src/**'] }),
    );
    expect(violations).toContainEqual({ kind: 'deleted', file: 'README.md' });
    expect(violations).toContainEqual({ kind: 'path', file: 'outside.txt' });
    expect(violations).toContainEqual({ kind: 'path', file: 'README.md' });
    expect(violations.find((v) => v.file === 'src/a.ts')).toBeUndefined();
  });

  it('lets a task write the files of scope.tests', async () => {
    const { dir, base } = await worktree();
    await writeFile(join(dir, 'src', 'a.spec.ts'), 'test\n');

    expect(
      await service.check(dir, base, scope({ paths: ['src/**'] })),
    ).toEqual([]);
    expect(
      await service.check(
        dir,
        base,
        scope({ paths: ['src/a.ts'], tests: ['src/a.spec.ts'] }),
      ),
    ).toEqual([]);
  });

  it('checks the old path of a rename against the perimeter', async () => {
    const { dir, base } = await worktree();
    git(dir, 'mv', 'README.md', 'src/README.md');
    git(dir, 'commit', '-m', 'move');

    expect(await service.check(dir, base, scope({ paths: ['src'] }))).toEqual([
      { kind: 'path', file: 'README.md' },
    ]);
  });
});
