import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import type { Mission, MissionTask } from '../generated/prisma/client.js';
import { GitService } from './git-service.js';
import { MissionTasksService } from './mission-tasks.service.js';
import { planSchema } from './plan-schema.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

const plan = planSchema.parse({
  title: 'Mission',
  goal: 'g',
  checks: { test: 'npm test' },
  team: {
    orchestrator: 'claude:opus',
    roles: { implementer: { agent: 'writer', model: 'claude:sonnet' } },
  },
  milestones: [
    { id: 'm1', title: 'One', tasks: [{ key: 'a', title: 'Task A', acceptance: ['ok'] }] },
  ],
});

let root = '';
let repo = '';
let missionWorktree = '';
let taskWorktree = '';

async function rig() {
  root = await mkdtemp(join(tmpdir(), 'algo-actions-'));
  repo = join(root, 'repo');
  missionWorktree = join(root, 'mission');
  taskWorktree = join(root, 'task');
  await mkdir(repo);
  await writeFile(join(repo, 'a.txt'), 'base\n');
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'mission/7-mission', base);
  git(repo, 'worktree', 'add', missionWorktree, 'mission/7-mission');
  git(repo, 'branch', 'mission/7/a', base);
  git(repo, 'worktree', 'add', taskWorktree, 'mission/7/a');

  const mission: Partial<Mission> = {
    id: 7,
    projectId: 2,
    userId: 1,
    title: 'Mission',
    status: 'waiting',
    mode: 'step',
    input: 'x',
    planJson: JSON.stringify(plan),
    planVersion: 1,
    branch: 'mission/7-mission',
    worktreePath: missionWorktree,
    baseCommit: base,
    waitJson: JSON.stringify({ code: 'task_review', taskId: 11 }),
    budgetJson: '{}',
    costUsd: 0,
  };
  const task: Partial<MissionTask> = {
    id: 11,
    missionId: 7,
    key: 'a',
    milestone: 'm1',
    status: 'review',
    branch: 'mission/7/a',
    worktreePath: taskWorktree,
    taskBase: base,
    attempts: 0,
    notesJson: '[]',
    reportJson: JSON.stringify({
      attempt: 0,
      diff: { files: [], added: 0, removed: 0 },
      checks: [],
      review: { verdict: 'ok', output: 'bene' },
      iterations: 1,
      warnings: [],
      costUsd: 0.1,
      summary: 'fatto',
    }),
  };
  const entries: { kind: string; data: unknown }[] = [];
  const prisma = {
    mission: {
      findFirst: async () => mission,
      update: async ({ data }: { data: Partial<Mission> }) => {
        Object.assign(mission, data);
        return mission;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { status?: string };
        data: Partial<Mission>;
      }) => {
        if (where.status && mission.status !== where.status) return { count: 0 };
        Object.assign(mission, data);
        return { count: 1 };
      },
    },
    missionTask: {
      findFirst: async () => task,
      findMany: async () => [task],
      update: async ({ data }: { data: Partial<MissionTask> & { attempts?: { increment: number } } }) => {
        const increment = (data as Record<string, unknown>).attempts as
          | { increment: number }
          | undefined;
        if (increment && typeof increment === 'object') {
          task.attempts = (task.attempts ?? 0) + increment.increment;
          const { attempts: _attempts, ...rest } = data;
          Object.assign(task, rest);
        } else {
          Object.assign(task, data);
        }
        return task;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { status?: string | { in: string[] } };
        data: Partial<MissionTask>;
      }) => {
        const status = where.status;
        const matches =
          status === undefined ||
          (typeof status === 'string' ? task.status === status : status.in.includes(task.status!));
        if (!matches) return { count: 0 };
        Object.assign(task, data);
        return { count: 1 };
      },
    },
    missionEntry: {
      create: async ({ data }: { data: { kind: string; dataJson: string } }) => {
        entries.push({ kind: data.kind, data: JSON.parse(data.dataJson) });
        return { id: entries.length, ...data };
      },
    },
    run: { findMany: async () => [] },
    project: { findUnique: async () => ({ path: repo }) },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
  };
  const service = new MissionTasksService(
    prisma as never,
    {
      get: async () => ({ ...mission }),
      record: async (_id: number, kind: string, data: unknown) => {
        entries.push({ kind, data });
        return {};
      },
    } as never,
    {
      withLock: async <T>(_id: number, fn: () => Promise<T>) => fn(),
      wake: () => undefined,
    } as never,
    { get: async () => ({ id: 2, path: repo }) } as never,
    new GitService({ get: () => undefined } as never),
    {
      missionTaskDiffKb: () => 20,
      resolvedDataDir: async () => root,
    } as never,
    { enqueue: async () => ({ id: 99 }) } as never,
    { queuePublish: async () => ({ id: 1 }) } as never,
  );
  return { service, mission, task, entries, base };
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('MissionTasksService.ok', () => {
  it('merges a clean task branch and closes the task', async () => {
    const { service, mission, task } = await rig();
    await writeFile(join(taskWorktree, 'b.txt'), 'new\n');
    git(taskWorktree, 'add', '-A');
    git(taskWorktree, 'commit', '-m', 'task work');

    await service.ok(1, 7, 'a');

    expect(task.status).toBe('done');
    expect(task.worktreePath).toBeNull();
    expect(mission.status).toBe('running');
    expect(mission.waitJson).toBeNull();
    expect(await readFile(join(missionWorktree, 'b.txt'), 'utf8')).toBe('new\n');
  });

  it('aborts a conflicting merge and blocks the task', async () => {
    const { service, mission, task, entries } = await rig();
    await writeFile(join(taskWorktree, 'a.txt'), 'task\n');
    git(taskWorktree, 'add', '-A');
    git(taskWorktree, 'commit', '-m', 'task work');
    await writeFile(join(missionWorktree, 'a.txt'), 'mission\n');
    git(missionWorktree, 'add', '-A');
    git(missionWorktree, 'commit', '-m', 'mission work');

    await expect(service.ok(1, 7, 'a')).rejects.toBeInstanceOf(ConflictException);

    expect(task.status).toBe('blocked');
    expect(JSON.parse(task.reportJson!).blocked.reason).toBe('merge');
    expect(mission.status).toBe('waiting');
    expect(JSON.parse(mission.waitJson!)).toMatchObject({ code: 'task_blocked' });
    expect(git(missionWorktree, 'status', '--porcelain')).toBe('');
    expect(entries.some((e) => e.kind === 'wait')).toBe(true);
  });
});

describe('MissionTasksService.redo', () => {
  it('puts the branch back on the mission tip and records the note', async () => {
    const { service, mission, task, base } = await rig();
    task.status = 'blocked';
    mission.status = 'waiting';
    mission.waitJson = JSON.stringify({ code: 'task_blocked', taskId: 11 });
    await writeFile(join(missionWorktree, 'a.txt'), 'mission\n');
    git(missionWorktree, 'add', '-A');
    git(missionWorktree, 'commit', '-m', 'mission work');
    const tip = git(missionWorktree, 'rev-parse', 'HEAD');
    await writeFile(join(taskWorktree, 'a.txt'), 'task\n');
    git(taskWorktree, 'add', '-A');
    git(taskWorktree, 'commit', '-m', 'task work');

    await service.redo(1, 7, 'a', 'cambia approccio');

    expect(task.status).toBe('pending');
    expect(task.attempts).toBe(1);
    expect(task.taskBase).toBe(tip);
    expect(task.taskBase).not.toBe(base);
    expect(JSON.parse(task.notesJson!)).toEqual(['cambia approccio']);
    expect(git(taskWorktree, 'rev-parse', 'HEAD')).toBe(tip);
    expect(await readFile(join(taskWorktree, 'a.txt'), 'utf8')).toBe('mission\n');
    expect(mission.status).toBe('running');
    expect(mission.waitJson).toBeNull();
  });
});

describe('MissionTasksService.retryFinalChecks', () => {
  it('goes back to running when the user retries after final_checks', async () => {
    const { service, mission } = await rig();
    mission.status = 'waiting';
    mission.waitJson = JSON.stringify({ code: 'final_checks', detail: 'rosso' });

    await service.retryFinalChecks(1, 7);

    expect(mission.status).toBe('running');
    expect(mission.waitJson).toBeNull();
  });
});

describe('MissionTasksService.skip', () => {
  it('skips a blocked task and lets the mission go on', async () => {
    const { service, mission, task } = await rig();
    task.status = 'blocked';
    mission.status = 'waiting';
    mission.waitJson = JSON.stringify({ code: 'task_blocked', taskId: 11 });

    await service.skip(1, 7, 'a');

    expect(task.status).toBe('skipped');
    expect(mission.status).toBe('running');
    expect(mission.waitJson).toBeNull();
  });

  it('refuses an Ok twice', async () => {
    const { service, task } = await rig();
    task.status = 'review';
    await writeFile(join(taskWorktree, 'b.txt'), 'new\n');
    git(taskWorktree, 'add', '-A');
    git(taskWorktree, 'commit', '-m', 'task work');
    await service.ok(1, 7, 'a');
    await expect(service.ok(1, 7, 'a')).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a task of a mission that no longer waits on it', async () => {
    const { service, mission, task } = await rig();
    task.status = 'blocked';
    mission.status = 'aborted';
    mission.waitJson = null;

    await expect(service.redo(1, 7, 'a', 'riprova')).rejects.toThrow(
      'La missione non aspetta questo task',
    );
    expect(task.status).toBe('blocked');
    expect(mission.status).toBe('aborted');
  });
});
