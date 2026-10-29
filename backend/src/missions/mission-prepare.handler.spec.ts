import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mission, Run } from '../generated/prisma/client.js';
import { RunConfig } from '../runs/run-config.js';
import type { RunEventData } from '../runs/run-types.js';
import { ChecksService } from './checks.service.js';
import { GitService } from './git-service.js';
import { missionBranchName, missionWorktreePath } from './mission-paths.js';
import { MissionPrepareHandler } from './mission-prepare.handler.js';
import { planSchema, type Plan } from './plan-schema.js';
import { Sandbox, type SandboxCommand, type SandboxSpec } from './sandbox.js';

class FakeSandbox extends Sandbox {
  async available() {
    return { available: true };
  }
  wrap(argv: string[], _spec: SandboxSpec): SandboxCommand {
    return { command: argv[0], args: argv.slice(1) };
  }
}

const gitBin = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function plan(checks: Record<string, unknown> = { test: 'node -e "0"' }): Plan {
  return planSchema.parse({
    title: 'Login Google',
    goal: 'g',
    checks,
    team: {
      orchestrator: 'claude:opus',
      roles: { integrator: { agent: 'assistant', model: 'claude:sonnet' } },
    },
    milestones: [{ id: 'm', tasks: [{ key: 'a', acceptance: ['ok'] }] }],
  });
}

function mission(target: Plan): Mission {
  return {
    id: 7,
    projectId: 2,
    userId: 1,
    title: 'Login Google',
    status: 'approved',
    mode: 'step',
    input: 'x',
    planJson: JSON.stringify(target),
    planVersion: 1,
    approvedVersion: 1,
    orchestratorModel: 'claude:opus',
    sessionId: null,
    fromSession: null,
    baseBranch: 'main',
    baseCommit: null,
    branch: null,
    worktreePath: null,
    prUrl: null,
    waitJson: null,
    budgetJson: '{}',
    costUsd: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    approvedAt: new Date(),
    finishedAt: null,
    seenAt: null,
  };
}

async function rig(target: Plan = plan()) {
  const root = await mkdtemp(join(tmpdir(), 'algo-prepare-'));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const repo = join(root, 'repo');
  await mkdir(repo);
  gitBin(repo, 'init', '-b', 'main');
  gitBin(repo, 'config', 'user.name', 'Test');
  gitBin(repo, 'config', 'user.email', 'test@example.com');
  await writeFile(join(repo, 'a.txt'), 'a\n');
  gitBin(repo, 'add', '-A');
  gitBin(repo, 'commit', '-m', 'init');
  const baseCommit = gitBin(repo, 'rev-parse', 'HEAD');

  const state = mission(target);
  const missionTable = {
    findUnique: async () => ({
      ...state,
      project: { id: state.projectId, path: repo },
    }),
    update: async ({ data }: { data: Partial<Mission> }) => {
      Object.assign(state, data);
      return state;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { status?: string };
      data: Partial<Mission>;
    }) => {
      if (where.status && state.status !== where.status) return { count: 0 };
      Object.assign(state, data);
      return { count: 1 };
    },
  };
  const prisma = {
    mission: missionTable,
    missionTask: {
      createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }),
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        mission: missionTable,
        missionTask: { createMany: async () => ({ count: 1 }) },
      }),
  };
  const config = new RunConfig({
    get: (name: string) =>
      ({
        DATA_DIR: dataDir,
        MISSION_CHECK_TIMEOUT_MS: '20000',
        MISSION_CHECK_OUTPUT_KB: '64',
      })[name],
  } as never);
  const git = new GitService({ get: () => undefined } as never);
  const checks = new ChecksService(config, new FakeSandbox(), git, {
    project: { findMany: async () => [{ path: repo }] },
  } as never);
  const recordings: { kind: string; data: unknown; extra: unknown }[] = [];
  const missions = {
    record: async (
      _id: number,
      kind: string,
      data: unknown,
      extra: unknown,
    ) => {
      recordings.push({ kind, data, extra });
      return { id: recordings.length };
    },
  };
  const handler = new MissionPrepareHandler(
    prisma as never,
    git,
    checks,
    config,
    { variables: async () => ({}) } as never,
    missions as never,
    { wake: () => undefined } as never,
    { register: () => undefined } as never,
  );
  const run = { id: 99, missionId: state.id } as Run;
  const worktree = missionWorktreePath(dataDir, state.projectId, state.id);
  return { root, repo, baseCommit, state, handler, run, worktree, recordings };
}

async function drain(
  handler: MissionPrepareHandler,
  run: Run,
  signal = new AbortController().signal,
) {
  const events: RunEventData[] = [];
  const iterator = handler.execute(run, signal);
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { events, outcome: next.value };
    events.push(next.value);
  }
}

describe('MissionPrepareHandler', () => {
  it('creates branch and worktree, runs the checks and goes to running', async () => {
    const {
      root,
      repo,
      baseCommit,
      state,
      handler,
      run,
      worktree,
      recordings,
    } = await rig();
    try {
      const { events, outcome } = await drain(handler, run);
      expect(outcome).toBe('done');
      expect(state.status).toBe('running');
      expect(state.branch).toBe(missionBranchName(7, 'Login Google'));
      expect(state.baseCommit).toBe(baseCommit);
      expect(state.worktreePath).toBe(await realpath(worktree));
      expect(existsSync(join(worktree, 'a.txt'))).toBe(true);
      expect(
        events.some(
          (e) =>
            e.type === 'prepare_step' &&
            e.step === 'worktree' &&
            e.status === 'done',
        ),
      ).toBe(true);
      expect(
        gitBin(
          repo,
          'rev-parse',
          '--abbrev-ref',
          missionBranchName(7, 'Login Google'),
        ),
      ).toBe(missionBranchName(7, 'Login Google'));
      expect(recordings).toContainEqual({
        kind: 'status',
        data: { status: 'running' },
        extra: undefined,
      });

      // Idempotent: a second preparation on a running mission does nothing.
      expect((await drain(handler, run)).outcome).toBe('done');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('goes to waiting baseline when the test is red, naming the step', async () => {
    const { root, state, handler, run, recordings } = await rig(
      plan({ test: `node -e "process.exit(1)"` }),
    );
    try {
      const { outcome } = await drain(handler, run);
      expect(outcome).toBe('done');
      expect(state.status).toBe('waiting');
      const wait = JSON.parse(state.waitJson!) as Record<string, string>;
      expect(wait).toMatchObject({ code: 'baseline', step: 'test' });
      expect(wait.runId).toBe(99);
      expect(recordings.some((r) => r.kind === 'wait')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops at setup when it fails', async () => {
    const { root, state, handler, run } = await rig(
      plan({ setup: `node -e "process.exit(3)"`, test: 'node -e "0"' }),
    );
    try {
      await drain(handler, run);
      expect(state.status).toBe('waiting');
      expect(JSON.parse(state.waitJson!)).toMatchObject({
        code: 'baseline',
        step: 'setup',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves the mission approved when the user stops it during setup', async () => {
    const { root, state, handler, run, worktree } = await rig(
      plan({
        setup: `node -e "setTimeout(()=>{},10000)"`,
        test: 'node -e "0"',
      }),
    );
    const controller = new AbortController();
    try {
      const running = drain(handler, run, controller.signal);
      setTimeout(() => controller.abort(), 300);
      const { outcome } = await running;
      expect(outcome).toBe('done');
      expect(state.status).toBe('approved');
      expect(state.waitJson).toBeNull();
      // The worktree stays: the stop doesn't delete work.
      expect(existsSync(worktree)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
