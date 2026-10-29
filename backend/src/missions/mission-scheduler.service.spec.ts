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
  );
  const started: string[] = [];
  (scheduler as unknown as { start: (m: unknown, p: unknown, t: { key: string }, r: unknown) => Promise<void> }).start =
    async (_m, _p, task) => {
      started.push(task.key);
    };
  const finals: number[] = [];
  const recorded: { kind: string; data: unknown }[] = [];
  if (options.checkResults) {
    // Exercise the real final checks.
    (scheduler as unknown as { missions: { record: (id: number, kind: string, data: unknown) => Promise<unknown> } }).missions.record =
      async (_id: number, kind: string, data: unknown) => {
        recorded.push({ kind, data });
        return {};
      };
  } else {
    (scheduler as unknown as { finalChecks: (m: Mission) => Promise<void> }).finalChecks =
      async (m) => {
        finals.push(m.id);
      };
  }
  return {
    scheduler,
    state,
    started,
    finals,
    created,
    waits,
    recorded,
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

  it('closes the mission when the final checks pass', async () => {
    const { pass, state, recorded } = rig([{ key: 'a', status: 'done' }], {
      checkResults: [{ ok: true, name: 'test' }],
    });
    await pass();
    expect(state.status).toBe('done');
    expect(recorded.some((e) => e.kind === 'final')).toBe(true);
  });

  it('waits with final_checks when they fail', async () => {
    const { pass, state } = rig([{ key: 'a', status: 'done' }], {
      checkResults: [{ ok: false, name: 'test', output: 'guasto' }],
    });
    await pass();
    expect(state.status).toBe('waiting');
    expect(JSON.parse(state.waitJson!)).toMatchObject({ code: 'final_checks' });
  });

  it('creates the task rows of a running mission without them', async () => {
    const { pass, created } = rig([]);
    await pass();
    expect(created).toHaveLength(2);
  });
});
