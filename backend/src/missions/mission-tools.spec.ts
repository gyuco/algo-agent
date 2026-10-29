import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mission } from '../generated/prisma/client.js';
import { ChecksService } from './checks.service.js';
import { GitService } from './git-service.js';
import { MissionEventBus } from './mission-event-bus.js';
import { MissionTools } from './mission-tools.js';
import { planSchema } from './plan-schema.js';
import { Sandbox, type SandboxCommand, type SandboxSpec } from './sandbox.js';
import { ScopeService } from './scope.service.js';
import { RunConfig } from '../runs/run-config.js';

/** A mission table and its log, enough for the two tools. */
function fakePrisma(mission: Mission) {
  let nextEntry = 1;
  const entries: {
    id: number;
    missionId: number;
    kind: string;
    dataJson: string;
  }[] = [];
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
        if (where.status && mission.status !== where.status)
          return { count: 0 };
        Object.assign(mission, data);
        return { count: 1 };
      },
    },
    missionEntry: {
      create: async ({
        data,
      }: {
        data: { missionId: number; kind: string; dataJson: string };
      }) => {
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

/** Checks that run the commands here, recording what the sandbox was asked. */
class FakeSandbox extends Sandbox {
  readonly commands: string[][] = [];
  async available() {
    return { available: true };
  }
  wrap(argv: string[], _spec: SandboxSpec): SandboxCommand {
    this.commands.push(argv);
    return { command: argv[0], args: argv.slice(1) };
  }
}

function tools(
  prisma: unknown,
  checks: ChecksService,
  scopeService: ScopeService,
  secrets: Record<string, string> = {},
) {
  const vault = { variables: async () => secrets };
  return new MissionTools(
    prisma as never,
    new MissionEventBus(),
    checks,
    scopeService,
    vault as never,
    { diffText: async () => '' } as never,
  );
}

function scope(
  target: Mission,
  validate: () => Promise<{ errors: string[]; sessions: number }>,
) {
  const turn = { closed: false, closing: false };
  return {
    turn,
    scope: {
      mission: target,
      runId: 1,
      purpose: 'briefing' as const,
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
    const built = new MissionTools(
      prisma as never,
      new MissionEventBus(),
      { ensureSetup: async () => null, run: async () => [] } as never,
      { check: async () => [] } as never,
      { variables: async () => ({}) } as never,
      { diffText: async () => '' } as never,
    ).forRun(state.scope);

    const result = await (
      built[0] as never as {
        handler: (
          args: unknown,
          extra: unknown,
        ) => Promise<{ content: { text: string }[] }>;
      }
    ).handler({ question: 'Quale provider?', options: ['Google'] }, {});

    expect(result.content[0].text).toContain('Turno chiuso');
    expect(target.waitJson).toBe(
      JSON.stringify({ code: 'question', entryId: 1 }),
    );
    expect(entries[0]).toMatchObject({ kind: 'question' });
    expect(state.turn.closed).toBe(true);
    expect(state.scope.beginClose()).toBe(false);
  });

  it('keeps the turn open when the plan does not validate', async () => {
    const target = mission();
    const { prisma } = fakePrisma(target);
    const state = scope(target, async () => ({ errors: ['no'], sessions: 0 }));
    const built = new MissionTools(
      prisma as never,
      new MissionEventBus(),
      { ensureSetup: async () => null, run: async () => [] } as never,
      { check: async () => [] } as never,
      { variables: async () => ({}) } as never,
      { diffText: async () => '' } as never,
    ).forRun(state.scope);

    const handler = (
      built[1] as never as {
        handler: (
          args: unknown,
          extra: unknown,
        ) => Promise<{ content: { text: string }[] }>;
      }
    ).handler;
    const result = await handler({ plan: validPlan }, {});

    expect(result.content[0].text).toContain('Piano non valido');
    expect(state.turn.closed).toBe(false);
    expect(target.status).toBe('briefing');
  });

  it('saves a plan once and does not bump the version for an identical one', async () => {
    const target = mission();
    const { prisma, entries } = fakePrisma(target);
    const state = scope(target, async () => ({ errors: [], sessions: 3 }));
    const built = new MissionTools(
      prisma as never,
      new MissionEventBus(),
      { ensureSetup: async () => null, run: async () => [] } as never,
      { check: async () => [] } as never,
      { variables: async () => ({}) } as never,
      { diffText: async () => '' } as never,
    ).forRun(state.scope);
    const handler = (
      built[1] as never as {
        handler: (
          args: unknown,
          extra: unknown,
        ) => Promise<{ content: { text: string }[] }>;
      }
    ).handler;

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

describe('MissionTools.run_checks', () => {
  async function rig(
    checksPlan: Record<string, unknown> = {},
    secrets: Record<string, string> = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), 'algo-run-checks-'));
    const dataDir = join(root, 'data');
    await mkdir(dataDir, { recursive: true });
    const repo = join(root, 'repo');
    await mkdir(repo);
    const gitBin = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    gitBin('init', '-b', 'main');
    gitBin('config', 'user.name', 'Test');
    gitBin('config', 'user.email', 'test@example.com');
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'x' }));
    gitBin('add', '-A');
    gitBin('commit', '-m', 'init');
    const base = gitBin('rev-parse', 'HEAD').trim();

    const sandbox = new FakeSandbox();
    const git = new GitService({ get: () => undefined } as never);
    const checks = new ChecksService(
      new RunConfig({
        get: (name: string) =>
          ({
            DATA_DIR: dataDir,
            MISSION_CHECK_TIMEOUT_MS: '20000',
            MISSION_CHECK_OUTPUT_KB: '64',
          })[name],
      } as never),
      sandbox,
      git,
      { project: { findMany: async () => [{ path: repo }] } } as never,
    );
    const plan = planSchema.parse({
      title: 'P',
      goal: 'G',
      checks: { test: 'node -e "0"', ...checksPlan },
      team: {
        orchestrator: 'claude:opus',
        roles: { integrator: { agent: 'assistant', model: 'claude:sonnet' } },
      },
      milestones: [{ id: 'm', tasks: [{ key: 'a', acceptance: ['ok'] }] }],
    });
    const missionTools = tools({}, checks, new ScopeService(git), secrets);
    const scope = {
      missionId: 1,
      runId: 1,
      userId: 1,
      projectId: 1,
      worktree: repo,
      taskBase: base,
      plan,
    };
    return { root, repo, base, sandbox, missionTools, scope };
  }

  it('checks the perimeter before running anything', async () => {
    const { root, repo, sandbox, missionTools, scope } = await rig();
    try {
      await writeFile(
        join(repo, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { nuovo: '1' } }),
      );
      const result = await missionTools.runChecks(scope, { names: ['test'] });
      expect(result.ok).toBe(false);
      expect(result.text).toContain('Fuori perimetro');
      expect(result.text).toContain('"nuovo"');
      expect(sandbox.commands).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs setup by itself, then the requested checks', async () => {
    const { root, sandbox, missionTools, scope } = await rig({
      setup: `node -e "require('fs').appendFileSync('setup.log','x')"`,
    });
    try {
      const result = await missionTools.runChecks(scope, { names: ['test'] });
      expect(result.ok).toBe(true);
      expect(sandbox.commands).toHaveLength(2);
      expect(sandbox.commands[0][0]).toBe('node');
      expect(sandbox.commands[0][1]).toBe('-e');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a pattern only with testFilter, and validates it', async () => {
    const { root, missionTools, scope } = await rig();
    try {
      const missing = await missionTools.runChecks(scope, {
        names: ['test'],
        pattern: 'src/a.spec.ts',
      });
      expect(missing.ok).toBe(false);
      expect(missing.text).toContain('testFilter');

      const withFilter = await rig({ testFilter: '-- {{pattern}}' });
      try {
        const invalid = await withFilter.missionTools.runChecks(
          withFilter.scope,
          {
            names: ['test'],
            pattern: '$(rm -rf)',
          },
        );
        expect(invalid.ok).toBe(false);
        expect(invalid.text).toContain('Pattern non valido');
      } finally {
        await rm(withFilter.root, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes the pattern to test and cuts the output to 16 KB', async () => {
    const { root, missionTools, scope } = await rig({
      test: `node -e "process.stdout.write('a'.repeat(20000) + 'END' + process.argv[1])"`,
      testFilter: '-- {{pattern}}',
    });
    try {
      const result = await missionTools.runChecks(scope, {
        names: ['test'],
        pattern: 'filtro',
      });
      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.text) as { output: string }[];
      expect(Buffer.byteLength(parsed[0].output)).toBeLessThanOrEqual(
        16 * 1024,
      );
      expect(parsed[0].output).toContain('ENDfiltro');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
