import type { MissionTask } from '../generated/prisma/client.js';
import { planChanges } from './plan-diff.js';
import { planSchema, type Plan } from './plan-schema.js';

function plan(overrides: Record<string, unknown> = {}): Plan {
  return planSchema.parse({
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
    milestones: [
      {
        id: 'm1',
        title: 'First',
        tasks: [
          { key: 'a', acceptance: ['a works'] },
          { key: 'b', acceptance: ['b works'], needs: ['a'] },
        ],
      },
      {
        id: 'm2',
        title: 'Second',
        tasks: [{ key: 'c', acceptance: ['c works'] }],
      },
    ],
    ...overrides,
  });
}

function rows(statuses: Record<string, string>): Pick<MissionTask, 'key' | 'status'>[] {
  return Object.entries(statuses).map(([key, status]) => ({ key, status }));
}

const base = plan();

describe('planChanges', () => {
  it('allows removing and editing pending tasks of unstarted milestones', () => {
    const proposed = plan({
      milestones: [
        {
          id: 'm1',
          title: 'First',
          tasks: [{ key: 'a', acceptance: ['a works'] }],
        },
        {
          id: 'm2',
          title: 'Second',
          tasks: [
            { key: 'c', acceptance: ['c works'] },
            { key: 'd', acceptance: ['d works'] },
          ],
        },
      ],
    });
    const changes = planChanges(
      base,
      proposed,
      rows({ a: 'running', b: 'pending', c: 'pending' }),
    );
    expect(changes.errors).toEqual([]);
    expect(changes.changes.removedTasks).toEqual(['b']);
    expect(changes.changes.addedTasks).toEqual(['d']);
  });

  it('never changes a task already run', () => {
    const proposed = plan({
      milestones: [
        {
          id: 'm1',
          title: 'First',
          tasks: [
            { key: 'a', title: 'Changed', acceptance: ['a works'] },
            { key: 'b', acceptance: ['b works'], needs: ['a'] },
          ],
        },
        { id: 'm2', title: 'Second', tasks: [{ key: 'c', acceptance: ['c works'] }] },
      ],
    });
    const changes = planChanges(base, proposed, rows({ a: 'done', b: 'pending', c: 'pending' }));
    expect(changes.errors.join('\n')).toMatch(/tasks\.a: chiavi, criteri/);
  });

  it('never removes a task already run', () => {
    const proposed = plan({
      milestones: [
        { id: 'm1', title: 'First', tasks: [{ key: 'b', acceptance: ['b works'] }] },
        { id: 'm2', title: 'Second', tasks: [{ key: 'c', acceptance: ['c works'] }] },
      ],
    });
    const changes = planChanges(base, proposed, rows({ a: 'done', b: 'pending', c: 'pending' }));
    expect(changes.errors.join('\n')).toMatch(/tasks\.a: un task già eseguito non si toglie/);
  });

  it('adds a corrective task only to the milestone just reviewed', () => {
    const proposed = plan({
      milestones: [
        {
          id: 'm1',
          title: 'First',
          tasks: [
            { key: 'a', acceptance: ['a works'] },
            { key: 'b', acceptance: ['b works'], needs: ['a'] },
            { key: 'fix', acceptance: ['fixed'] },
          ],
        },
        { id: 'm2', title: 'Second', tasks: [{ key: 'c', acceptance: ['c works'] }] },
      ],
    });
    const changes = planChanges(
      base,
      proposed,
      rows({ a: 'done', b: 'done', c: 'pending' }),
      ['m1'],
    );
    expect(changes.errors).toEqual([]);
    expect(changes.corrective).toEqual(['fix']);

    const tooLate = planChanges(
      base,
      proposed,
      rows({ a: 'done', b: 'done', c: 'pending' }),
      ['m1', 'm2'],
    );
    expect(tooLate.errors.join('\n')).toMatch(/accetta nuovi task solo se è l'ultima chiusa/);
  });

  it('does not touch reviewed milestones otherwise', () => {
    const proposed = plan({
      milestones: [
        {
          id: 'm1',
          title: 'Renamed',
          tasks: [
            { key: 'a', acceptance: ['a works'] },
            { key: 'b', acceptance: ['b works'], needs: ['a'] },
          ],
        },
        { id: 'm2', title: 'Second', tasks: [{ key: 'c', acceptance: ['c works'] }] },
      ],
    });
    const changes = planChanges(
      base,
      proposed,
      rows({ a: 'done', b: 'done', c: 'pending' }),
      ['m1'],
    );
    expect(changes.errors.join('\n')).toMatch(/non cambia titolo|non si toglie/);
  });

  it('adds milestones after the last one, never before', () => {
    const after = plan({
      milestones: [
        ...base.milestones,
        { id: 'm3', title: 'Third', tasks: [{ key: 'e', acceptance: ['e works'] }] },
      ],
    });
    const added = planChanges(
      base,
      after,
      rows({ a: 'done', b: 'done', c: 'done' }),
      ['m1'],
    );
    expect(added.errors).toEqual([]);
    expect(added.changes.addedMilestones).toEqual(['m3']);

    const before = plan({
      milestones: [
        { id: 'm0', title: 'Zero', tasks: [{ key: 'z', acceptance: ['z'] }] },
        ...base.milestones,
      ],
    });
    expect(
      planChanges(base, before, rows({ a: 'done', b: 'done', c: 'done' })).errors.join('\n'),
    ).toMatch(/non si tolgono e non si riordinano/);
  });

  it('asks the user for scope, checks, team, budget or a new template', () => {
    const scope = plan({ scope: { paths: ['src/**'] } });
    expect(
      planChanges(base, scope, rows({ a: 'done', b: 'done', c: 'done' })),
    ).toMatchObject({ errors: [], requiresUser: true, changes: { sections: ['scope'] } });

    const template = plan({
      milestones: [
        {
          id: 'm1',
          title: 'First',
          tasks: [
            { key: 'a', acceptance: ['a works'] },
            { key: 'b', acceptance: ['b works'], needs: ['a'] },
          ],
        },
        {
          id: 'm2',
          title: 'Second',
          tasks: [{ key: 'c', template: 'task-config', acceptance: ['c works'] }],
        },
      ],
    });
    expect(
      planChanges(base, template, rows({ a: 'done', b: 'done', c: 'pending' })),
    ).toMatchObject({ requiresUser: true });
  });

  it('applies a plan identical to the approved one', () => {
    const changes = planChanges(
      base,
      base,
      rows({ a: 'done', b: 'done', c: 'done' }),
    );
    expect(changes).toMatchObject({
      errors: [],
      requiresUser: false,
      changes: {
        addedTasks: [],
        removedTasks: [],
        changedTasks: [],
        addedMilestones: [],
        sections: [],
      },
    });
  });
});
