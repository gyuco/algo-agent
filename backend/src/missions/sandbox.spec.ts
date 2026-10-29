import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunConfig } from '../runs/run-config.js';
import { MacSandbox, type SandboxSpec } from './sandbox.js';

const darwin = process.platform === 'darwin' ? it : it.skip;

const sandbox = (dataDir: string) =>
  new MacSandbox(
    new RunConfig({
      get: (name: string) =>
        ({ DATA_DIR: dataDir, MISSION_GIT_TIMEOUT_MS: '5000' })[name],
    } as never),
  );

async function paths() {
  const root = await mkdtemp(join(tmpdir(), 'algo-sandbox-'));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const worktree = join(root, 'worktree');
  const project = join(root, 'project');
  await mkdir(join(dataDir, 'sandbox-tmp'), { recursive: true });
  await mkdir(join(home, '.ssh'), { recursive: true });
  await mkdir(worktree, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(home, '.ssh', 'known_hosts'), 'secret');
  await writeFile(join(dataDir, 'db.sqlite'), 'secret');
  await writeFile(join(project, 'a.txt'), 'project');
  return { root, dataDir, home, worktree, project };
}

function spec(
  overrides: Partial<SandboxSpec> & { dataDir: string; worktree: string },
): SandboxSpec {
  return {
    tmp: join(overrides.dataDir, 'sandbox-tmp', 'one'),
    cache: join(overrides.dataDir, 'sandbox-cache', 'npm'),
    home: overrides.dataDir,
    projectGit: join(overrides.dataDir, 'project.git'),
    projects: [],
    network: false,
    ...overrides,
  };
}

function run(instance: MacSandbox, argv: string[], paths: SandboxSpec) {
  const wrapped = instance.wrap(argv, paths);
  return spawnSync(wrapped.command, wrapped.args, {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('MacSandbox', () => {
  it('includes the network opening only in setup', async () => {
    const { dataDir, worktree, root } = await paths();
    const instance = sandbox(dataDir);
    try {
      const closed = instance.profile(spec({ dataDir, worktree }));
      const open = instance.profile(spec({ dataDir, worktree, network: true }));
      expect(closed).toContain('(deny network-outbound)');
      expect(closed).not.toMatch(/\(allow network-outbound\)/);
      expect(open).toMatch(/\(allow network-outbound\)/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  darwin('passes its autotest on this machine', async () => {
    const { dataDir, root } = await paths();
    try {
      await expect(sandbox(dataDir).available()).resolves.toEqual({
        available: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  darwin(
    'denies reading credentials, the backend data and other projects',
    async () => {
      const { dataDir, home, worktree, project, root } = await paths();
      const instance = sandbox(dataDir);
      const pathspec = spec({
        dataDir,
        worktree,
        home,
        projects: [project],
      });
      try {
        expect(
          run(
            instance,
            ['/bin/cat', join(home, '.ssh', 'known_hosts')],
            pathspec,
          ).status,
        ).not.toBe(0);
        expect(
          run(instance, ['/bin/cat', join(dataDir, 'db.sqlite')], pathspec)
            .status,
        ).not.toBe(0);
        expect(
          run(instance, ['/bin/cat', join(project, 'a.txt')], pathspec).status,
        ).not.toBe(0);
        // A worktree still reads its own .git, not the project's files.
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  darwin(
    'allows writing inside the worktree and denies it outside',
    async () => {
      const { dataDir, home, worktree, root } = await paths();
      const instance = sandbox(dataDir);
      const pathspec = spec({ dataDir, worktree, home });
      try {
        expect(
          run(instance, ['/usr/bin/touch', join(worktree, 'ok')], pathspec)
            .status,
        ).toBe(0);
        expect(
          run(instance, ['/usr/bin/touch', join(home, 'no')], pathspec).status,
        ).not.toBe(0);
        expect(
          run(instance, ['/usr/bin/touch', join(dataDir, 'no')], pathspec)
            .status,
        ).not.toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  darwin('denies the network but keeps localhost reachable', async () => {
    const { dataDir, home, worktree, root } = await paths();
    const instance = sandbox(dataDir);
    const pathspec = spec({ dataDir, worktree, home });
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    try {
      expect(
        run(
          instance,
          ['/usr/bin/nc', '-z', '-w', '1', '1.1.1.1', '443'],
          pathspec,
        ).status,
      ).not.toBe(0);
      expect(
        run(
          instance,
          ['/usr/bin/nc', '-z', '-w', '2', '127.0.0.1', String(port)],
          pathspec,
        ).status,
      ).toBe(0);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  darwin(
    'lets git work on a worktree whose .git is in the project',
    async () => {
      const { dataDir, home, worktree, root } = await paths();
      const project = join(root, 'repo');
      await mkdir(project);
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' });
      git('init', '-b', 'main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.com');
      await writeFile(join(project, 'a.txt'), 'a\n');
      git('add', '-A');
      git('commit', '-m', 'init');
      git('worktree', 'add', '-b', 'task', worktree);

      const instance = sandbox(dataDir);
      const pathspec = spec({
        dataDir,
        worktree,
        home,
        projectGit: join(project, '.git'),
        projects: [project],
      });
      try {
        const status = run(instance, ['git', 'status', '--short'], {
          ...pathspec,
          tmp: join(dataDir, 'sandbox-tmp', 'git'),
        });
        expect(status.status, status.stderr).toBe(0);
        const log = run(instance, ['git', 'log', '--oneline', '-1'], {
          ...pathspec,
          tmp: join(dataDir, 'sandbox-tmp', 'git'),
        });
        expect(log.status, log.stderr).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  darwin(
    'fails its autotest with a profile that isolates nothing',
    async () => {
      const { dataDir, root } = await paths();
      class OpenSandbox extends MacSandbox {
        profile() {
          return '(version 1)\n(allow default)\n';
        }
      }
      try {
        const result = await new OpenSandbox(
          new RunConfig({
            get: (name: string) => ({ DATA_DIR: dataDir })[name],
          } as never),
        ).available();
        expect(result.available).toBe(false);
        expect(result.reason).toContain('sandbox');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
