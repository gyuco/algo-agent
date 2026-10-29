import { ConflictException } from '@nestjs/common';
import type { Mission } from '../generated/prisma/client.js';
import { MissionsService } from './missions.service.js';
import { planSchema } from './plan-schema.js';

const plan = planSchema.parse({
  title: 'Login',
  goal: 'g',
  checks: { test: 'npm test' },
  team: {
    orchestrator: 'claude:opus',
    roles: { integrator: { agent: 'assistant', model: 'claude:sonnet' } },
  },
  milestones: [{ id: 'm', tasks: [{ key: 'a', acceptance: ['ok'] }] }],
});

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 7,
    projectId: 2,
    userId: 1,
    title: 'Login',
    status: 'planned',
    mode: 'step',
    input: 'x',
    planJson: JSON.stringify(plan),
    planVersion: 1,
    approvedVersion: null,
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
    approvedAt: null,
    finishedAt: null,
    seenAt: null,
    progressJson: '{}',
    newProjectJson: null,
    ...overrides,
  };
}

function service(initial: Mission) {
  const state = initial;
  const entries: { kind: string; data: unknown }[] = [];
  let activePreparations = 0;
  const prisma = {
    mission: {
      findFirst: async ({
        where,
      }: {
        where: { id?: number; status?: string };
      }) => {
        if (where.id !== undefined && where.id !== state.id) return null;
        if (where.status && where.status !== state.status) return null;
        return state;
      },
      findUnique: async ({ where }: { where: { id?: number } }) =>
        where.id !== undefined && where.id !== state.id ? null : state,
      findMany: async ({ where }: { where: { status?: string } }) =>
        !where.status || where.status === state.status ? [state] : [],
      update: async ({ data }: { data: Partial<Mission> }) => {
        Object.assign(state, data);
        return state;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: number; status?: string | { not: string } };
        data: Partial<Mission>;
      }) => {
        const matches =
          typeof where.status === 'object'
            ? state.status !== where.status.not
            : !where.status || state.status === where.status;
        if (!matches) return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      },
    },
    run: {
      findFirst: async () => (activePreparations ? { id: 55 } : null),
      findMany: async () => [{ id: 55, status: 'running' }],
      count: async () => 0,
      updateMany: async () => ({ count: 0 }),
    },
    missionTask: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
    },
    missionEntry: {
      findMany: async ({ where }: { where: { kind?: string } }) =>
        entries
          .map((entry, i) => ({
            id: i + 1,
            kind: entry.kind,
            dataJson: JSON.stringify(entry.data),
          }))
          .filter((entry) => !where.kind || entry.kind === where.kind)
          .reverse(),
      create: async ({
        data,
      }: {
        data: { kind: string; dataJson: string };
      }) => {
        entries.push({ kind: data.kind, data: JSON.parse(data.dataJson) });
        return { id: entries.length, ...data };
      },
    },
  };
  const queue = {
    enqueue: vi.fn(async (data: { kind: string }) => {
      activePreparations += 1;
      return { id: 90, ...data };
    }),
    wake: vi.fn(),
  };
  const git = {
    isRepository: vi.fn(async () => true),
    checkRefFormat: vi.fn(async () => true),
    baseRef: vi.fn(async () => ({ ref: 'refs/heads/main', fetched: false })),
    revParse: vi.fn(async () => 'new-commit'),
    aheadOf: vi.fn(async () => 0),
    resetTo: vi.fn(async () => undefined),
    removeWorktree: vi.fn(async () => undefined),
    deleteBranch: vi.fn(async () => undefined),
    remoteHasCredentials: vi.fn(async () => false),
  };
  const sandbox = {
    available: vi.fn(
      async () =>
        ({ available: true }) as { available: boolean; reason?: string },
    ),
  };
  const runs = { abort: vi.fn(async () => undefined) };
  const missions = new MissionsService(
    prisma as never,
    { get: () => undefined } as never,
    { get: async () => ({ id: 2, path: '/repo' }) } as never,
    {
      forProject: async () => ({
        agents: new Map(),
        workflows: new Map(),
        skills: new Map(),
        tools: new Map(),
        mcp: new Map(),
      }),
    } as never,
    { isEnabled: () => () => true } as never,
    {
      validate: async () => ({ errors: [], sessions: 0 }),
      estimate: () => 0,
    } as never,
    {} as never,
    {} as never,
    queue as never,
    {} as never,
    runs as never,
    { publish: () => undefined, remember: () => undefined } as never,
    git as never,
    sandbox as never,
    { resolvedDataDir: async () => '/data' } as never,
    { view: async () => ({}), hasPlanData: async () => false } as never,
    { activity: () => null } as never,
  );
  return { missions, state, entries, queue, git, sandbox, runs, prisma };
}

describe('MissionsService.approve', () => {
  it('approves, queues the preparation and records it', async () => {
    const { missions, state, entries, queue } = service(mission());
    await missions.approve(1, 7, { planVersion: 1, mode: 'step' });

    expect(state.status).toBe('approved');
    expect(state.approvedVersion).toBe(1);
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mission-prepare', missionId: 7 }),
    );
    expect(entries).toContainEqual({ kind: 'prepare', data: { runId: 90 } });
  });

  it('refuses without a sandbox', async () => {
    const { missions, sandbox } = service(mission());
    sandbox.available.mockResolvedValue({
      available: false,
      reason: 'niente sandbox',
    });
    await expect(
      missions.approve(1, 7, { planVersion: 1, mode: 'step' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a project without git', async () => {
    const { missions, git } = service(mission());
    git.isRepository.mockResolvedValue(false);
    await expect(
      missions.approve(1, 7, { planVersion: 1, mode: 'step' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses automatic mode until the budget arrives', async () => {
    const { missions, state } = service(mission());
    await expect(
      missions.approve(1, 7, { planVersion: 1, mode: 'auto' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(state.status).toBe('planned');
  });

  it('refuses a mission that does not wait for an approval', async () => {
    const { missions } = service(mission({ status: 'briefing' }));
    await expect(
      missions.approve(1, 7, { planVersion: 1, mode: 'step' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('MissionsService.retryBaseline', () => {
  const waiting = () =>
    mission({
      status: 'waiting',
      baseCommit: 'old-commit',
      branch: 'mission/7-login',
      worktreePath: '/data/worktrees/2/7/main',
      waitJson: JSON.stringify({ code: 'baseline', runId: 55, step: 'test' }),
    });

  it('queues the preparation again when the base did not move', async () => {
    const { missions, state, queue, git } = service(waiting());
    git.revParse.mockResolvedValue('old-commit');
    await missions.retryBaseline(1, 7);

    expect(state.status).toBe('approved');
    expect(state.waitJson).toBeNull();
    expect(git.resetTo).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('resets the worktree when the base moved and there is no work', async () => {
    const { missions, state, git } = service(waiting());
    await missions.retryBaseline(1, 7);

    expect(git.resetTo).toHaveBeenCalledWith(
      '/data/worktrees/2/7/main',
      'new-commit',
    );
    expect(state.baseCommit).toBe('new-commit');
    expect(state.status).toBe('approved');
  });

  it('refuses to reset a worktree with work of its own', async () => {
    const { missions, git } = service(waiting());
    git.aheadOf.mockResolvedValue(2);
    await expect(missions.retryBaseline(1, 7)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(git.resetTo).not.toHaveBeenCalled();
  });

  it('refuses when the mission is not waiting for the baseline', async () => {
    const { missions } = service(mission({ status: 'running' }));
    await expect(missions.retryBaseline(1, 7)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('MissionsService.revise', () => {
  it('stops the preparation and removes branch and worktree', async () => {
    const { missions, state, git, runs } = service(
      mission({
        status: 'waiting',
        branch: 'mission/7-login',
        worktreePath: '/data/worktrees/2/7/main',
        waitJson: JSON.stringify({ code: 'baseline', runId: 55, step: 'test' }),
      }),
    );
    await missions.revise(1, 7);

    expect(runs.abort).toHaveBeenCalledWith(1, 55);
    expect(git.removeWorktree).toHaveBeenCalledWith(
      '/repo',
      '/data/worktrees/2/7/main',
    );
    expect(git.deleteBranch).toHaveBeenCalledWith('/repo', 'mission/7-login');
    expect(state.status).toBe('briefing');
    expect(state.branch).toBeNull();
    expect(state.worktreePath).toBeNull();
    expect(state.baseCommit).toBeNull();
  });
});

describe('MissionsService.resume', () => {
  it('goes back to the wait the stop interrupted', async () => {
    const wait = { code: 'baseline', runId: 55, step: 'test' };
    const { missions, state } = service(
      mission({ status: 'waiting', waitJson: JSON.stringify(wait) }),
    );
    await missions.abort(1, 7);
    expect(state.status).toBe('aborted');
    expect(state.waitJson).toBeNull();

    await missions.resume(1, 7);
    expect(state.status).toBe('waiting');
    expect(JSON.parse(state.waitJson!)).toEqual(wait);
    expect(state.finishedAt).toBeNull();
  });

  it('queues the preparation again after a stop recorded only by its status', async () => {
    const { missions, state, entries, queue } = service(
      mission({ status: 'aborted', finishedAt: new Date() }),
    );
    entries.push(
      { kind: 'status', data: { status: 'approved', version: 1 } },
      { kind: 'status', data: { status: 'aborted' } },
    );
    await missions.resume(1, 7);

    expect(state.status).toBe('approved');
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mission-prepare', missionId: 7 }),
    );
  });

  it('refuses while a run of the mission is still stopping', async () => {
    const { missions, prisma } = service(mission({ status: 'aborted' }));
    prisma.run.count = async () => 1;
    await expect(missions.resume(1, 7)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses a mission that is not stopped', async () => {
    const { missions } = service(mission({ status: 'running' }));
    await expect(missions.resume(1, 7)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('MissionsService.reconcile', () => {
  it('re-queues the preparation of an approved mission without one', async () => {
    const { missions, queue } = service(mission({ status: 'approved' }));
    await missions.reconcile();
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mission-prepare', missionId: 7 }),
    );
  });
});
