import type { Mission } from '../generated/prisma/client.js';
import { MissionEventBus } from './mission-event-bus.js';
import { MissionTools } from './mission-tools.js';
import { planSchema } from './plan-schema.js';

/** A mission table and its log, enough for the two tools. */
function fakePrisma(mission: Mission) {
  let nextEntry = 1;
  const entries: { id: number; missionId: number; kind: string; dataJson: string }[] = [];
  const prisma = {
    mission: {
      findUnique: async () => ({
        planJson: mission.planJson,
        planVersion: mission.planVersion,
        status: mission.status,
      }),
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
    missionEntry: {
      create: async ({ data }: { data: { missionId: number; kind: string; dataJson: string } }) => {
        const entry = { id: nextEntry++, ...data, createdAt: new Date() };
        entries.push(entry);
        return entry;
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
  };
  return { prisma, entries };
}

function mission(): Mission {
  return {
    id: 1,
    projectId: 1,
    userId: 1,
    title: 'T',
    status: 'briefing',
    mode: 'step',
    input: 'x',
    planJson: null,
    planVersion: 0,
    approvedVersion: null,
    orchestratorModel: 'claude:opus',
    sessionId: null,
    fromSession: null,
    baseBranch: 'main',
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
  };
}

const validPlan = planSchema.parse({
  title: 'P',
  goal: 'G',
  checks: { test: 'npm test' },
  team: {
    orchestrator: 'claude:opus',
    roles: { integrator: { agent: 'assistant', model: 'claude:sonnet' } },
  },
  milestones: [{ id: 'm', tasks: [{ key: 'a', acceptance: ['ok'] }] }],
});

function scope(target: Mission, validate: () => Promise<{ errors: string[]; sessions: number }>) {
  const turn = { closed: false, closing: false };
  return {
    turn,
    scope: {
      mission: target,
      runId: 1,
      validate,
      closeTurn: () => {
        turn.closed = true;
      },
      beginClose: () => {
        if (turn.closed || turn.closing) return false;
        turn.closing = true;
        return true;
      },
      cancelClose: () => {
        turn.closing = false;
      },
    },
  };
}

describe('MissionTools', () => {
  it('records a question, waits for the answer and closes the turn', async () => {
    const target = mission();
    const { prisma, entries } = fakePrisma(target);
    const state = scope(target, async () => ({ errors: [], sessions: 0 }));
    const tools = new MissionTools(prisma as never, new MissionEventBus()).forRun(state.scope);

    const result = await (tools[0] as never as {
      handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
    }).handler({ question: 'Quale provider?', options: ['Google'] }, {});

    expect(result.content[0].text).toContain('Turno chiuso');
    expect(target.waitJson).toBe(JSON.stringify({ code: 'question', entryId: 1 }));
    expect(entries[0]).toMatchObject({ kind: 'question' });
    expect(state.turn.closed).toBe(true);
    expect(state.scope.beginClose()).toBe(false);
  });

  it('keeps the turn open when the plan does not validate', async () => {
    const target = mission();
    const { prisma } = fakePrisma(target);
    const state = scope(target, async () => ({ errors: ['no'], sessions: 0 }));
    const tools = new MissionTools(prisma as never, new MissionEventBus()).forRun(state.scope);

    const handler = (tools[1] as never as {
      handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
    }).handler;
    const result = await handler({ plan: validPlan }, {});

    expect(result.content[0].text).toContain('Piano non valido');
    expect(state.turn.closed).toBe(false);
    expect(target.status).toBe('briefing');
  });

  it('saves a plan once and does not bump the version for an identical one', async () => {
    const target = mission();
    const { prisma, entries } = fakePrisma(target);
    const state = scope(target, async () => ({ errors: [], sessions: 3 }));
    const tools = new MissionTools(prisma as never, new MissionEventBus()).forRun(state.scope);
    const handler = (tools[1] as never as {
      handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
    }).handler;

    await handler({ plan: validPlan }, {});
    expect(target.status).toBe('planned');
    expect(target.planVersion).toBe(1);
    expect(target.title).toBe('P');
    expect(entries[0]).toMatchObject({ kind: 'plan' });

    target.status = 'briefing';
    state.turn.closed = false;
    state.turn.closing = false;
    await handler({ plan: validPlan }, {});
    expect(target.planVersion).toBe(1);
    expect(target.status).toBe('planned');
  });
});
