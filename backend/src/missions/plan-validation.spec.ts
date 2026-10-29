import { join } from 'node:path';
import type { IsEnabled } from '../agents/project-resources.service.js';
import { buildCatalog, readCatalogDir } from '../catalog/catalog.js';
import type { ProvidersService } from '../providers/providers.service.js';
import type { VaultService } from '../vault/vault.service.js';
import type { GitService } from './git-service.js';
import { PlanValidationService } from './plan-validation.js';
import { planSchema, type Plan } from './plan-schema.js';

const providers = {
  ids: () => ['claude'],
  statuses: async () => [
    {
      provider: 'claude',
      connected: true,
      models: [
        { value: 'claude:opus', displayName: 'Opus', efforts: [] },
        { value: 'claude:sonnet', displayName: 'Sonnet', efforts: [] },
      ],
    },
  ],
} as unknown as ProvidersService;

const git = {
  isRepository: async () => false,
  branchExists: async () => false,
  checkRefFormat: async (_cwd: string, branch: string) =>
    /^[A-Za-z0-9._/-]+$/.test(branch) && !branch.includes('..'),
} as unknown as GitService;

const vault = {
  variables: async () => ({ DATABASE_URL: 'postgres://x' }),
} as unknown as VaultService;

const validation = new PlanValidationService(providers, git, vault);
const project = {
  id: 1,
  path: '/tmp/definitely-not-a-git-repository-for-plan-tests',
};
const enabled = (): IsEnabled => () => true;

async function catalog() {
  return buildCatalog(await readCatalogDir(join(process.cwd(), 'catalog')));
}

function plan(overrides: Record<string, unknown> = {}): Plan {
  return planSchema.parse({
    title: 'Login',
    goal: 'Gli utenti entrano con Google',
    checks: { test: 'npm test' },
    team: {
      orchestrator: 'claude:opus',
      roles: {
        tester: { agent: 'assistant', model: 'claude:sonnet' },
        implementer: { agent: 'assistant', model: 'claude:sonnet' },
        reviewer: { agent: 'reviewer', model: 'claude:sonnet' },
        integrator: { agent: 'assistant', model: 'claude:sonnet' },
      },
    },
    milestones: [
      {
        id: 'backend',
        tasks: [
          {
            key: 'login',
            title: 'Login',
            template: 'task-tdd',
            acceptance: ['GET /login reindirizza'],
          },
        ],
      },
    ],
    ...overrides,
  });
}

async function errors(input: Plan, enabledFn: IsEnabled = enabled()) {
  const result = await validation.validate(
    1,
    project,
    input,
    await catalog(),
    enabledFn,
  );
  return result.errors;
}

describe('PlanValidationService', () => {
  it('accepts a plan that uses the shipped task models', async () => {
    expect(await errors(plan())).toEqual([]);
  });

  it('rejects duplicate keys, future dependencies and cycles', async () => {
    const duplicate = plan({
      milestones: [
        {
          id: 'm1',
          tasks: [
            { key: 'a', template: 'task-tdd', acceptance: ['x'], needs: [] },
          ],
        },
        {
          id: 'm2',
          tasks: [
            { key: 'a', template: 'task-tdd', acceptance: ['x'], needs: [] },
          ],
        },
      ],
    });
    expect(await errors(duplicate)).toContain(
      'tasks.a: chiave duplicata nel piano',
    );

    const future = plan({
      milestones: [
        {
          id: 'm1',
          tasks: [
            { key: 'a', template: 'task-tdd', acceptance: ['x'], needs: ['b'] },
          ],
        },
        {
          id: 'm2',
          tasks: [
            { key: 'b', template: 'task-tdd', acceptance: ['x'], needs: [] },
          ],
        },
      ],
    });
    expect(await errors(future)).toContain(
      'tasks.a.needs[0]: "b" è in una milestone successiva',
    );

    const cycle = plan({
      milestones: [
        {
          id: 'm1',
          tasks: [
            { key: 'a', template: 'task-tdd', acceptance: ['x'], needs: ['b'] },
            { key: 'b', template: 'task-tdd', acceptance: ['x'], needs: ['a'] },
          ],
        },
      ],
    });
    expect(
      (await errors(cycle)).some((e) =>
        e.startsWith('needs: dipendenze cicliche'),
      ),
    ).toBe(true);
  });

  it('requires the integrator and the roles used by the templates', async () => {
    const noIntegrator = plan({
      team: {
        orchestrator: 'claude:opus',
        roles: {
          tester: { agent: 'assistant', model: 'claude:sonnet' },
          implementer: { agent: 'assistant', model: 'claude:sonnet' },
          reviewer: { agent: 'reviewer', model: 'claude:sonnet' },
        },
      },
    });
    expect(await errors(noIntegrator)).toContain(
      'team.roles.integrator: il ruolo è obbligatorio',
    );

    const noTester = plan({
      team: {
        orchestrator: 'claude:opus',
        roles: {
          implementer: { agent: 'assistant', model: 'claude:sonnet' },
          reviewer: { agent: 'reviewer', model: 'claude:sonnet' },
          integrator: { agent: 'assistant', model: 'claude:sonnet' },
        },
      },
    });
    expect(await errors(noTester)).toContain(
      'milestones[0].tasks[0].template: il modello usa il ruolo "tester", assente in team.roles',
    );
  });

  it('rejects a judge that is also a writer, after substitutions', async () => {
    const same = plan({
      team: {
        orchestrator: 'claude:opus',
        roles: {
          tester: { agent: 'assistant', model: 'claude:sonnet' },
          implementer: { agent: 'assistant', model: 'claude:sonnet' },
          reviewer: { agent: 'assistant', model: 'claude:sonnet' },
          integrator: { agent: 'assistant', model: 'claude:sonnet' },
        },
      },
    });
    expect(await errors(same)).toContain(
      'milestones[0].tasks[0].agents: chi giudica (assistant) è anche chi scrive',
    );
  });

  it('rejects unavailable models and disabled or non-task templates', async () => {
    const model = plan({
      team: {
        orchestrator: 'claude:opus',
        roles: {
          tester: { agent: 'assistant', model: 'claude:ghost' },
          implementer: { agent: 'assistant', model: 'claude:sonnet' },
          reviewer: { agent: 'reviewer', model: 'claude:sonnet' },
          integrator: { agent: 'assistant', model: 'claude:sonnet' },
        },
      },
    });
    expect(await errors(model)).toContain(
      'team.roles.tester.model: il modello claude:ghost non è disponibile',
    );

    const disabled = await errors(
      plan(),
      (kind, key) => !(kind === 'workflow' && key === 'task-tdd'),
    );
    expect(disabled).toContain(
      'milestones[0].tasks[0].template: il modello "task-tdd" non è abilitato nel progetto',
    );

    const normal = plan({
      milestones: [
        {
          id: 'm1',
          tasks: [
            {
              key: 'a',
              template: 'review-and-fix',
              acceptance: ['x'],
              needs: [],
            },
          ],
        },
      ],
    });
    expect(await errors(normal)).toContain(
      'milestones[0].tasks[0].template: "review-and-fix" non è un modello di task',
    );
  });
});

describe('planSchema', () => {
  it('requires checks.test and one acceptance criterion per task', () => {
    const missingTest = planSchema.safeParse({
      title: 'x',
      goal: 'x',
      checks: {},
      team: { orchestrator: 'claude:opus', roles: {} },
      milestones: [{ id: 'm', tasks: [{ key: 'a', acceptance: ['x'] }] }],
    });
    expect(missingTest.success).toBe(false);

    const noCriteria = planSchema.safeParse({
      title: 'x',
      goal: 'x',
      checks: { test: 'npm test' },
      team: { orchestrator: 'claude:opus', roles: {} },
      milestones: [{ id: 'm', tasks: [{ key: 'a' }] }],
    });
    expect(noCriteria.success).toBe(false);
  });

  it('rejects a task whose final check would run no command', async () => {
    const docs = plan({
      milestones: [
        {
          id: 'docs',
          tasks: [
            {
              key: 'readme',
              template: 'task-docs',
              acceptance: ['README aggiornato'],
            },
          ],
        },
      ],
    });
    expect((await errors(docs)).join('\n')).toMatch(
      /checks non ne definisce nessuno/,
    );
    expect(
      await errors({
        ...docs,
        checks: { ...docs.checks, lint: 'npm run lint' },
      }),
    ).toEqual([]);
  });

  it('refuses shell operators in the commands', async () => {
    const base = plan();
    const messages = await errors({
      ...base,
      checks: { ...base.checks, test: 'npm test && npm run lint' },
    });
    expect(messages.join('\n')).toMatch(/checks\.test: .*operatore di shell/);

    const filter = planSchema.safeParse({
      ...base,
      checks: { ...base.checks, testFilter: '--' },
    });
    expect(filter.success).toBe(false);
    expect(
      planSchema.safeParse({
        ...base,
        checks: { ...base.checks, testFilter: '-- {{pattern}}' },
      }).success,
    ).toBe(true);
  });

  it('accepts only secrets that exist in the vault', async () => {
    const base = plan();
    expect(
      (
        await errors({
          ...base,
          checks: { ...base.checks, secrets: ['DATABASE_URL'] },
        })
      ).join('\n'),
    ).toBe('');
    expect(
      (
        await errors({
          ...base,
          checks: { ...base.checks, secrets: ['MISSING'] },
        })
      ).join('\n'),
    ).toMatch(/checks\.secrets\[0\]: il segreto "MISSING" non esiste/);
  });

  it('refuses an invalid base branch name', async () => {
    const base = plan();
    expect((await errors({ ...base, baseBranch: 'a..b' })).join('\n')).toMatch(
      /baseBranch: "a\.\.b" non è un nome di branch valido/,
    );
  });

  it('counts only agent steps, and repeat multiplies its step and check only', async () => {
    const result = await validation.validate(
      1,
      project,
      plan(),
      await catalog(),
      enabled(),
    );
    expect(result.sessions).toBe(7);
  });

  it('refuses task-tdd in the first milestone of a new project', async () => {
    const result = await validation.validate(
      1,
      { id: null, path: '/tmp/briefing' },
      plan(),
      await catalog(),
      enabled(),
    );
    expect(result.errors.join('\n')).toMatch(/task-tdd vuole test già esistenti/);
    expect(result.errors.join('\n')).toMatch(/deve essere lo scaffolding/);
  });

  it('keeps every path of the plan inside the project', () => {
    const base = plan();
    for (const bad of ['../other', '/etc', '~/x', 'a/../../b', 'C:\\x']) {
      const input = { ...base, checks: { ...base.checks, workdir: bad } };
      expect(planSchema.safeParse(input).success).toBe(false);
      expect(
        planSchema.safeParse({
          ...base,
          scope: { ...base.scope, paths: [bad] },
        }).success,
      ).toBe(false);
    }
    expect(
      planSchema.safeParse({
        ...base,
        checks: { ...base.checks, workdir: 'backend' },
        scope: {
          ...base.scope,
          paths: ['backend/src/**'],
          tests: ['**/*.spec.ts'],
        },
      }).success,
    ).toBe(true);
  });
});
