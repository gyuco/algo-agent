import type { AgentSpec, WorkflowSpec } from '../catalog/catalog.js';
import type { Mission } from '../generated/prisma/client.js';
import { planSchema, type Plan } from './plan-schema.js';
import { TaskGraphFactory } from './task-graph.factory.js';

const agent = (key: string, files: 'none' | 'read' | 'write'): AgentSpec => ({
  key,
  description: key,
  enabledByDefault: true,
  permissions: { files, tools: [], mcp: [], skills: [] },
  prompt: key,
});

const plan = (custom = false): Plan =>
  planSchema.parse({
    title: 'Mission',
    goal: 'g',
    checks: { build: 'npm run build', test: 'npm test' },
    team: {
      orchestrator: 'claude:opus',
      roles: {
        tester: { agent: 'writer', model: 'claude:sonnet', maxTurns: 12 },
        implementer: { agent: 'writer', model: 'claude:sonnet', maxTurns: 80 },
        reviewer: { agent: 'reader', model: 'claude:opus', maxTurns: 20 },
      },
      custom: custom
        ? [
            {
              key: 'docs',
              description: 'docs writer',
              model: 'claude:haiku',
              permissions: { files: 'write', skills: [] },
              prompt: 'write docs',
            },
          ]
        : [],
    },
    milestones: [
      {
        id: 'm1',
        title: 'First',
        tasks: [
          {
            key: 'a',
            title: 'Task A',
            template: 'task-tdd',
            agents: custom ? { implementer: 'docs' } : {},
            needs: [],
            acceptance: ['works'],
          },
        ],
      },
    ],
  });

const template = (): WorkflowSpec => ({
  key: 'task-tdd',
  description: 'tdd',
  enabledByDefault: true,
  input: 'Task',
  task: true,
  result: 'verify',
  steps: [
    { id: 'tests', agent: 'role:tester', prompt: '{{task}}' },
    { id: 'red', run: ['test'], expect: 'fail' },
    { id: 'implement', agent: 'role:implementer', prompt: '{{task}}' },
    {
      id: 'verify',
      agent: 'role:reviewer',
      verdict: ['ok', 'problemi'],
      prompt: 'review',
    },
  ],
});

const mission = {
  id: 7,
  title: 'Mission',
} as Mission;

function setup(custom = false) {
  const team = {
    roles: plan(custom).team.roles,
    custom: plan(custom).team.custom,
    agents: new Map([
      ['writer', agent('writer', 'write')],
      ['reader', agent('reader', 'read')],
    ]),
  };
  return new TaskGraphFactory().build(
    mission,
    plan(custom),
    plan(custom).milestones[0].tasks[0] as never,
    template(),
    team,
  );
}

describe('TaskGraphFactory', () => {
  it('resolves a role from the team with its model and maxTurns', () => {
    const graph = setup();
    expect(graph.steps.map((s) => s.id)).toEqual([
      'tests',
      'red',
      'implement',
      'verify',
    ]);
    expect(graph.agents.tests.spec.model).toBe('claude:sonnet');
    expect(graph.agents.tests.spec.maxTurns).toBe(12);
    expect(graph.agents.verify.spec.maxTurns).toBe(20);
  });

  it('replaces a role with the custom agent of the plan', () => {
    const graph = setup(true);
    expect(graph.agents.implement.spec.key).toBe('docs');
    expect(graph.agents.implement.spec.model).toBe('claude:haiku');
    expect(graph.agents.implement.spec.permissions.files).toBe('write');
  });

  it('gives run_checks only to the agents that write', () => {
    const graph = setup();
    expect(graph.agents.tests.tools).toEqual(['run_checks']);
    expect(graph.agents.implement.tools).toEqual(['run_checks']);
    expect(graph.agents.verify.tools).toEqual([]);
  });

  it('writes {{task}} with notes, the previous attempt and dependencies', () => {
    const text = new TaskGraphFactory().text(
      mission,
      plan(),
      { ...plan().milestones[0].tasks[0], milestone: 'm1' } as never,
      {
        notes: ['prima nota', 'seconda nota'],
        previous: { diff: '--- a\n+++ b', review: 'problemi: manca x' },
      },
      [
        {
          key: 'base',
          title: 'Base',
          summary: 'fatto',
          commit: 'abcdef1234567',
        },
        {
          key: 'saltato',
          title: 'Saltato',
          summary: '',
          commit: '',
          skipped: true,
        },
      ],
    );
    expect(text).toContain('## Task a: Task A');
    expect(text).toContain('Milestone: First');
    expect(text).toContain('1. prima nota');
    expect(text).toContain('```diff');
    expect(text).toContain('Last review: problemi: manca x');
    expect(text).toContain('base — Base: fatto (commit abcdef1)');
    expect(text).toContain('skipped, its work is not in the branch');
    expect(text).toContain('build: npm run build');
  });

  it('tells when an agent is no longer enabled in the project', () => {
    const graph = setup();
    const catalog = {
      agents: new Map([
        ['writer', agent('writer', 'write')],
        ['reader', agent('reader', 'read')],
      ]),
    };
    const missing = new TaskGraphFactory().unavailable(
      graph,
      catalog as never,
      (kind, key) => !(kind === 'agent' && key === 'reader'),
    );
    expect(missing.join(' ')).toContain('reader');
  });
});
