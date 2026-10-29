import type { Mission } from '../generated/prisma/client.js';
import { MissionScheduler } from './mission-scheduler.service.js';
import { planSchema } from './plan-schema.js';

const plan = planSchema.parse({
  title: 'Mission',
  goal: 'g',
  checks: { test: 'npm test' },
  team: {
    orchestrator: 'claude:opus',
    roles: { implementer: { agent: 'writer', model: 'claude:sonnet' } },
  },
  milestones: [
    {
      id: 'm1',
      tasks: [
        { key: 'a', template: 'task-tdd', acceptance: ['ok'] },
        { key: 'b', template: 'task-tdd', needs: ['a'], acceptance: ['ok'] },
      ],
    },
  ],
});

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 7,
    projectId: 2,
    userId: 1,
    title: 'Mission',
    status: 'running',
    mode: 'step',
    input: 'x',
    planJson: JSON.stringify(plan),
    planVersion: 1,
    approvedVersion: 1,
    orchestratorModel: 'claude:opus',
    sessionId: null,
    fromSession: null,
    baseBranch: 'main',
    baseCommit: 'base',
    branch: 'mission/7-mission',
    worktreePath: '/tmp/worktree',
    prUrl: null,
    waitJson: null,
    budgetJson: '{}',
    costUsd: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    approvedAt: new Date(),
    finishedAt: null,
    seenAt: null,
    progressJson: '{}',
    newProjectJson: null,
    ...overrides,
  };
}

function rig(
  tasks: { key: string; status: string }[],
  options: { runStatus?: string; checkResults?: { ok: boolean; output?: string; name?: string }[] } = {},
) {
  const runStatus = options.runStatus ?? 'running';
  const state = mission();
  const created: unknown[] = [];
  const waits: unknown[] = [];
  const prisma = {
    mission: {
      findUnique: async () => state,
      updateMany: async ({ data }: { data: Partial<Mission> }) => {
        Object.assign(state, data);
        return { count: 1 };
      },
    },
    missionTask: {
      count: async () => tasks.length,
      createMany: async ({ data }: { data: unknown[] }) => {
        created.push(...data);
        return { count: data.length };
      },
      findMany: async () =>
        tasks.map((task, i) => ({
          id: i + 1,
          missionId: state.id,
          key: task.key,
          milestone: 'm1',
          status: task.status,
          branch: null,
          worktreePath: null,
          taskBase: null,
          runId: 10 + i,
          attempts: 0,
          notesJson: '[]',
          reportJson: null,
          startedAt: null,
          finishedAt: null,
        })),
    },
    run: { findUnique: async () => ({ id: 10, status: runStatus }) },
  };
  const scheduler = new MissionScheduler(
    prisma as never,
    { resolvedDataDir: async () => '/tmp' } as never,
    {} as never, // projects
    {} as never, // catalog
    {} as never, // resources
    {} as never, // runner
    {} as never, // queue
    {} as never, // git
    { run: async () => options.checkResults ?? [] } as never, // checks
    { variables: async () => ({}) } as never, // vault
    {} as never, // factory
    {
      record: async (_id: number, kind: string, data: unknown) => {
        if (kind === 'wait') waits.push(data);
        return {};
      },
    } as never, // missions
    { gate: async () => ({ ok: true }) } as never, // budget
    {
      busy: async () => false,
      queueChecks: async () => ({}),
      reviewMilestone: async () => undefined,
    } as never, // flow
    { publish: () => undefined } as never, // bus
  );
  const started: string[] = [];
  (scheduler as unknown as { start: (m: unknown, p: unknown, t: { key: string }, r: unknown) => Promise<void> }).start =
    async (_m, _p, task) => {
      started.push(task.key);
    };
  const finals: number[] = [];
  (scheduler as unknown as { flow: unknown }).flow = {
    busy: async () => false,
    queueChecks: async (m: Mission) => {
      finals.push(m.id);
      return {};
    },
    reviewMilestone: async () => undefined,
  };
  return {
    scheduler,
    state,
    started,
    finals,
    created,
    waits,
    pass: () =>
      (scheduler as unknown as { pass: (id: number) => Promise<void> }).pass(
        state.id,
      ),
  };
}

describe('MissionScheduler', () => {
  it('starts one task at a time: nothing new while a task runs', async () => {
    const { pass, started } = rig([
      { key: 'a', status: 'running' },
      { key: 'b', status: 'pending' },
    ]);
    await pass();
    expect(started).toEqual([]);
  });

  it('starts only the steps whose needs are done or skipped', async () => {
    const { pass, started } = rig([
      { key: 'a', status: 'pending' },
      { key: 'b', status: 'pending' },
    ]);
    await pass();
    expect(started).toEqual(['a']);
  });

  it('starts a dependent when its dependency was skipped', async () => {
    const { pass, started } = rig([
      { key: 'a', status: 'skipped' },
      { key: 'b', status: 'pending' },
    ]);
    await pass();
    expect(started).toEqual(['b']);
  });

  it('waits with the blocked task when nothing can run', async () => {
    const { pass, state, started, waits } = rig([
      { key: 'a', status: 'blocked' },
      { key: 'b', status: 'pending' },
    ]);
    await pass();
    expect(started).toEqual([]);
    expect(state.status).toBe('waiting');
    expect(JSON.parse(state.waitJson!)).toMatchObject({
      code: 'task_blocked',
      taskId: 1,
    });
    expect(waits).toHaveLength(1);
  });

  it('runs the final checks when every task is closed', async () => {
    const { pass, finals } = rig([
      { key: 'a', status: 'done' },
      { key: 'b', status: 'skipped' },
    ]);
    await pass();
    expect(finals).toEqual([7]);
  });

  it('creates the task rows of a running mission without them', async () => {
    const { pass, created } = rig([]);
    await pass();
    expect(created).toHaveLength(2);
  });
});

function autoPlan(
  milestones: {
    id: string;
    tasks: { key: string; needs?: string[] }[];
  }[],
  parallelTasks = 2,
) {
  return planSchema.parse({
    title: 'Mission',
    goal: 'g',
    checks: { test: 'npm test' },
    team: {
      orchestrator: 'claude:opus',
      roles: { implementer: { agent: 'writer', model: 'claude:sonnet' } },
    },
    parallelTasks,
    milestones: milestones.map((m) => ({
      ...m,
      tasks: m.tasks.map((t) => ({
        ...t,
        template: 'task-tdd',
        acceptance: ['ok'],
      })),
    })),
  });
}

function autoRig(
  statuses: { key: string; status: string }[],
  options: {
    parallelTasks?: number;
    milestones?: { id: string; tasks: { key: string; needs?: string[] }[] }[];
    reviewed?: string[];
  } = {},
) {
  const plan = autoPlan(
    options.milestones ?? [
      {
        id: 'm1',
        tasks: statuses.map((task) => ({
          key: task.key,
          needs: [],
        })),
      },
    ],
    options.parallelTasks ?? 2,
  );
  const state = mission({
    mode: 'auto',
    planJson: JSON.stringify(plan),
    progressJson: JSON.stringify({
      reviewedMilestones: options.reviewed ?? [],
    }),
  });
  const milestoneOf = new Map(
    plan.milestones.flatMap((m) =>
      m.tasks.map((task) => [task.key, m.id] as const),
    ),
  );
  const rows = statuses.map((task, i) => ({
    id: i + 1,
    missionId: state.id,
    key: task.key,
    milestone: milestoneOf.get(task.key) ?? 'm1',
    status: task.status,
    branch: `mission/7/${task.key}`,
    worktreePath: null,
    taskBase: 'base',
    runId: null,
    attempts: 0,
    notesJson: '[]',
    reportJson: null,
    startedAt: null,
    finishedAt: null,
  }));
  const prisma = {
    mission: {
      findUnique: async () => state,
      updateMany: async ({ data }: { data: Partial<Mission> }) => {
        Object.assign(state, data);
        return { count: 1 };
      },
      update: async ({ data }: { data: Partial<Mission> }) => {
        Object.assign(state, data);
        return state;
      },
    },
    missionTask: {
      count: async () => rows.length,
      createMany: async () => ({ count: 0 }),
      findMany: async () => rows,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: number; key?: string };
        data: { status?: string };
      }) => {
        const row = rows.find(
          (r) => (where.id !== undefined && r.id === where.id) || r.key === where.key,
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    run: {
      findUnique: async () => null,
      count: async () => 0,
      enqueue: async () => ({ id: 1 }),
    },
    missionEntry: { findFirst: async () => null, create: async () => ({}) },
  };
  const scheduler = new MissionScheduler(
    prisma as never,
    { resolvedDataDir: async () => '/tmp', limits: () => ({ missionTasks: 6 }) } as never,
    { get: async () => ({ id: 2, path: '/repo' }) } as never,
    {} as never,
    {} as never,
    {} as never,
    { enqueue: async () => ({ id: 1 }) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { record: async () => ({}) } as never,
    { gate: async () => ({ ok: true }) } as never,
    {
      busy: async () => false,
      queueChecks: async () => ({}),
      reviewMilestone: async () => undefined,
    } as never,
    { publish: () => undefined } as never,
  );
  const started: string[] = [];
  const checks: string[] = [];
  const merged: string[] = [];
  (scheduler as unknown as { start: (m: unknown, p: unknown, t: { key: string }) => Promise<void> }).start =
    async (_m, _p, task) => {
      started.push(task.key);
    };
  (scheduler as unknown as { mergeTask: (m: unknown, p: unknown, t: { key: string }) => Promise<void> }).mergeTask =
    async (_m, _p, task) => {
      merged.push(task.key);
    };
  (scheduler as unknown as {
    flow: {
      busy: () => Promise<boolean>;
      queueChecks: (m: unknown, purpose: string) => Promise<unknown>;
      reviewMilestone: () => Promise<void>;
    };
  }).flow = {
    busy: async () => false,
    queueChecks: async (_m: unknown, purpose: string) => {
      checks.push(purpose);
      return {};
    },
    reviewMilestone: async () => undefined,
  };
  return {
    started,
    checks,
    merged,
    state,
    pass: () =>
      (scheduler as unknown as { pass: (id: number) => Promise<void> }).pass(
        state.id,
      ),
  };
}

describe('MissionScheduler automatic', () => {
  it('starts independent tasks together up to parallelTasks', async () => {
    const { pass, started } = autoRig(
      [
        { key: 'a', status: 'pending' },
        { key: 'b', status: 'pending' },
        { key: 'c', status: 'pending' },
      ],
      { parallelTasks: 2 },
    );
    await pass();
    expect(started).toEqual(['a', 'b']);
  });

  it('fills a free slot while another task runs', async () => {
    const { pass, started } = autoRig(
      [
        { key: 'a', status: 'running' },
        { key: 'b', status: 'pending' },
        { key: 'c', status: 'pending' },
      ],
      { parallelTasks: 2 },
    );
    await pass();
    expect(started).toEqual(['b']);
  });

  it('merges a ready task while another runs', async () => {
    const { pass, merged, started } = autoRig([
      { key: 'a', status: 'running' },
      { key: 'b', status: 'ready' },
    ]);
    await pass();
    expect(merged).toEqual(['b']);
    expect(started).toEqual([]);
  });

  it('does not start the next milestone before the review', async () => {
    const { pass, started, checks } = autoRig(
      [
        { key: 'a', status: 'done' },
        { key: 'c', status: 'pending' },
      ],
      {
        milestones: [
          { id: 'm1', tasks: [{ key: 'a' }] },
          { id: 'm2', tasks: [{ key: 'c' }] },
        ],
      },
    );
    await pass();
    expect(started).toEqual([]);
    expect(checks).toEqual(['milestone']);
  });

  it('starts the tasks a block does not depend on', async () => {
    const { pass, started } = autoRig(
      [
        { key: 'a', status: 'blocked' },
        { key: 'b', status: 'pending' },
        { key: 'c', status: 'pending' },
      ],
      {
        milestones: [
          {
            id: 'm1',
            tasks: [
              { key: 'a' },
              { key: 'b' },
              { key: 'c', needs: ['a'] },
            ],
          },
        ],
      },
    );
    await pass();
    expect(started).toEqual(['b']);
  });
});
