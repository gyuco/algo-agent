import type { Mission } from '../generated/prisma/client.js';
import type { RateLimitSnapshot } from '../claude/rate-limit.js';
import {
  BudgetGuard,
  continueBudget,
  initialBudget,
  readBudget,
  rethresholdBudget,
} from './budget-guard.service.js';
import { weightOf } from './model-weights.js';
import { planSchema } from './plan-schema.js';

const plan = planSchema.parse({
  title: 'Mission',
  goal: 'g',
  checks: { test: 'npm test' },
  team: {
    orchestrator: 'claude:opus',
    roles: {
      implementer: { agent: 'writer', model: 'claude:sonnet' },
      integrator: { agent: 'writer', model: 'claude:sonnet' },
    },
  },
  budget: { fiveHourMinRemaining: 0.1, weeklyMaxShare: 0.3 },
  milestones: [{ id: 'm1', tasks: [{ key: 'a', acceptance: ['ok'] }] }],
});

function mission(id: number, overrides: Partial<Mission> = {}): Mission {
  return {
    id,
    projectId: 1,
    userId: 1,
    title: `Mission ${id}`,
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
    branch: null,
    worktreePath: null,
    prUrl: null,
    waitJson: null,
    budgetJson: JSON.stringify({
      fiveHourMinRemaining: 0.1,
      weeklyMaxShare: 0.3,
      weekly: { used: 0, allowance: 0.3, week: { resetsAt: '', used: 0 } },
      usd: {},
    }),
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

function snapshot(
  fiveHour: number | null,
  week: number,
  resetsAt = '2026-11-02T00:00:00.000Z',
  windows: Record<string, { utilization: number; status?: string }> = {},
): RateLimitSnapshot {
  return {
    status: 'allowed',
    windows: {
      ...(fiveHour === null
        ? {}
        : {
            five_hour: {
              utilization: fiveHour,
              resetsAt: '2026-10-29T12:00:00.000Z',
              status: 'allowed' as const,
            },
          }),
      seven_day: {
        utilization: week,
        resetsAt,
        status: 'allowed',
      },
      ...Object.fromEntries(
        Object.entries(windows).map(([name, w]) => [
          name,
          {
            utilization: w.utilization,
            resetsAt,
            status: (w.status ?? 'allowed') as 'allowed' | 'rejected',
          },
        ]),
      ),
    },
    overage: { status: null, disabledReason: null },
    observedAt: new Date().toISOString(),
  };
}

function rig(options: {
  missions?: Mission[];
  rateLimits?: RateLimitSnapshot | null;
  method?: string;
  cursor?: { utilization: number; resetsAt: string | null };
  cap?: string;
} = {}) {
  const store = new Map(
    (options.missions ?? [mission(1)]).map((m) => [m.id, { ...m }]),
  );
  const state: Record<string, unknown> = {
    rateLimits: options.rateLimits ?? null,
    ...(options.cursor ? { budgetCursor: options.cursor } : {}),
  };
  const prisma = {
    mission: {
      findUnique: async ({ where }: { where: { id: number } }) =>
        store.get(where.id) ?? null,
      findMany: async ({ where }: { where: { userId: number } }) =>
        [...store.values()].filter((m) => m.userId === where.userId),
      update: async ({
        where,
        data,
      }: {
        where: { id: number };
        data: Partial<Mission>;
      }) => {
        Object.assign(store.get(where.id)!, data);
        return store.get(where.id);
      },
    },
  };
  const connections = {
    find: async () => ({
      method: options.method ?? 'oauth_token',
      state,
    }),
    updateState: async (
      _userId: number,
      _provider: string,
      patch: Record<string, unknown>,
    ) => {
      Object.assign(state, patch);
    },
  };
  const providers = {
    ids: () => ['claude', 'opencode'],
    get: () => ({ refreshUsage: async () => undefined }),
  };
  const config = {
    get: (name: string) =>
      name === 'MISSIONS_WEEKLY_MAX_SHARE' ? options.cap : undefined,
  };
  const guard = new BudgetGuard(
    prisma as never,
    config as never,
    providers as never,
    connections as never,
  );
  return { guard, store, state };
}

const tokens = (model: string, input = 1_000) => ({
  model,
  input,
  output: 1_000,
  cacheRead: 0,
  cacheWrite: 0,
});

describe('rethresholdBudget', () => {
  it('keeps the share used and the Continues of a mission under way', () => {
    const start = initialBudget({
      fiveHourMinRemaining: 0.1,
      weeklyMaxShare: 0.3,
      maxUsd: 10,
    });
    const used = continueBudget({
      ...start,
      weekly: { ...start.weekly, used: 0.25 },
    });
    const next = rethresholdBudget(used, {
      fiveHourMinRemaining: 0.2,
      weeklyMaxShare: 0.4,
      maxUsd: 15,
    });
    expect(next.weekly.used).toBe(0.25);
    expect(next.weekly.allowance).toBeCloseTo(0.7);
    expect(next.usd.allowance).toBe(25);
    expect(next.fiveHourMinRemaining).toBe(0.2);
  });
});

describe('model weights', () => {
  it('weighs opus more than sonnet, and sonnet more than haiku', () => {
    expect(weightOf(tokens('claude-opus-4'))).toBeGreaterThan(
      weightOf(tokens('claude-sonnet-4')),
    );
    expect(weightOf(tokens('claude-sonnet-4'))).toBeGreaterThan(
      weightOf(tokens('claude-haiku-4')),
    );
  });
});

describe('BudgetGuard.gate', () => {
  it('pauses below the five-hour threshold and passes above it', async () => {
    const low = rig({ rateLimits: snapshot(0.95, 0.1) });
    await expect(low.guard.gate(1, 'claude:sonnet')).resolves.toMatchObject({
      ok: false,
      kind: 'five_hour',
    });
    const high = rig({ rateLimits: snapshot(0.5, 0.1) });
    await expect(high.guard.gate(1, 'claude:sonnet')).resolves.toEqual({
      ok: true,
    });
  });

  it('blocks an opus step on seven_day_opus and lets sonnet through', async () => {
    const { guard } = rig({
      rateLimits: snapshot(0.1, 0.1, undefined, {
        seven_day_opus: { utilization: 0.99 },
      }),
    });
    await expect(guard.gate(1, 'claude:opus')).resolves.toMatchObject({
      ok: false,
      kind: 'model_window',
      window: 'seven_day_opus',
    });
    await expect(guard.gate(1, 'claude:sonnet')).resolves.toEqual({ ok: true });
  });

  it('blocks at the mission weekly quota', async () => {
    const missionBudget = readBudget(mission(1));
    missionBudget.weekly.used = 0.35;
    const { guard } = rig({
      missions: [mission(1, { budgetJson: JSON.stringify(missionBudget) })],
      rateLimits: snapshot(0.1, 0.4),
    });
    await expect(guard.gate(1)).resolves.toEqual({
      ok: false,
      kind: 'weekly_mission',
    });
  });

  it('blocks when the user reached the global weekly cap', async () => {
    const first = readBudget(mission(1));
    first.weekly.week = {
      resetsAt: '2026-11-02T00:00:00.000Z',
      used: 0.4,
    };
    const second = readBudget(mission(2));
    second.weekly.week = {
      resetsAt: '2026-11-02T00:00:00.000Z',
      used: 0.3,
    };
    const { guard } = rig({
      missions: [
        mission(1, { budgetJson: JSON.stringify(first) }),
        mission(2, { budgetJson: JSON.stringify(second) }),
      ],
      rateLimits: snapshot(0.1, 0.7),
      cap: '0.6',
    });
    await expect(guard.gate(1)).resolves.toMatchObject({
      ok: false,
      kind: 'weekly_global',
    });
  });

  it('applies maxUsd when there is no plan data, and passes without it', async () => {
    const capped = rig({
      missions: [mission(1, { costUsd: 2 })],
      rateLimits: null,
      method: 'api_key',
    });
    capped.store.get(1)!.budgetJson = JSON.stringify({
      fiveHourMinRemaining: 0.1,
      weeklyMaxShare: 0.3,
      maxUsd: 1,
      weekly: { used: 0, allowance: 0.3, week: { resetsAt: '', used: 0 } },
      usd: { allowance: 1 },
    });
    await expect(capped.guard.gate(1)).resolves.toEqual({
      ok: false,
      kind: 'usd',
    });
    const free = rig({
      missions: [mission(1, { costUsd: 2 })],
      rateLimits: null,
      method: 'api_key',
    });
    await expect(free.guard.gate(1)).resolves.toMatchObject({ ok: true });
  });

  it('always passes a model that is not Claude', async () => {
    const { guard } = rig({ rateLimits: snapshot(0.99, 0.99) });
    await expect(guard.gate(1, 'opencode:gpt')).resolves.toEqual({ ok: true });
  });
});

describe('weekly attribution', () => {
  it('divides the growth by weight among missions and chats', async () => {
    const { guard, store } = rig({
      missions: [mission(1), mission(2)],
      rateLimits: snapshot(0.1, 0.3, undefined, {}),
      cursor: { utilization: 0.2, resetsAt: '2026-11-02T00:00:00.000Z' },
    });
    guard.recordTokens({ id: 10, userId: 1, missionId: 1 } as never, tokens('claude-opus-4'));
    guard.recordTokens({ id: 11, userId: 1, missionId: 2 } as never, tokens('claude-sonnet-4'));
    guard.recordTokens({ id: 12, userId: 1, missionId: null } as never, tokens('claude-sonnet-4'));

    const week = readBudget(store.get(1)!).weekly;
    const other = readBudget(store.get(2)!).weekly;
    await guard.snapshot(1, snapshot(0.1, 0.3));

    const one = readBudget(store.get(1)!).weekly.used;
    const two = readBudget(store.get(2)!).weekly.used;
    // The chat's part is not attributed to any mission: the missions get the rest.
    expect(one + two).toBeLessThan(0.1);
    expect(one + two).toBeGreaterThan(0.05);
    // Opus weighs more than sonnet, so its mission gets the larger share.
    expect(one).toBeGreaterThan(two);
    expect(one).toBeGreaterThan(0.05);
    // The mission's total counts across weeks; the week's share is the new one.
    expect(readBudget(store.get(1)!).weekly.week.used).toBeCloseTo(one, 6);
    expect(week.used).toBe(0);
    expect(other.allowance).toBe(0.3);
  });

  it('resets the week share when the weekly window changes', async () => {
    const { guard, store } = rig({
      missions: [mission(1)],
      rateLimits: snapshot(0.1, 0.2),
      cursor: {
        utilization: 0.9,
        resetsAt: '2026-10-26T00:00:00.000Z',
      },
    });
    guard.recordTokens({ id: 10, userId: 1, missionId: 1 } as never, tokens('claude-sonnet-4'));
    await guard.snapshot(1, snapshot(0.1, 0.2));
    const budget = readBudget(store.get(1)!);
    expect(budget.weekly.week.used).toBeCloseTo(0.2, 6);
    expect(budget.weekly.used).toBeCloseTo(0.2, 6);
    expect(budget.weekly.week.resetsAt).toBe('2026-11-02T00:00:00.000Z');
  });

  it('recalibrates a run on its real cost', async () => {
    const { guard, store } = rig({
      missions: [mission(1)],
      rateLimits: snapshot(0.1, 0.5),
      cursor: { utilization: 0.4, resetsAt: '2026-11-02T00:00:00.000Z' },
    });
    guard.recordTokens({ id: 10, userId: 1, missionId: 1 } as never, tokens('claude-sonnet-4'));
    guard.calibrate(10, 3);
    await guard.snapshot(1, snapshot(0.1, 0.5));
    // The only run gets the whole growth whatever its weight.
    expect(readBudget(store.get(1)!).weekly.used).toBeCloseTo(0.1, 6);
  });

  it('attributes nothing when no run has weight', async () => {
    const { guard, store } = rig({
      missions: [mission(1)],
      rateLimits: snapshot(0.1, 0.5),
      cursor: { utilization: 0.4, resetsAt: '2026-11-02T00:00:00.000Z' },
    });
    await guard.snapshot(1, snapshot(0.1, 0.5));
    expect(readBudget(store.get(1)!).weekly.used).toBe(0);
  });
});
