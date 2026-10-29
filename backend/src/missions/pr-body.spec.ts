import type { MissionEntry, MissionTask } from '../generated/prisma/client.js';
import { planSchema } from './plan-schema.js';
import { prBody } from './pr-body.js';

const plan = planSchema.parse({
  title: 'Mission',
  goal: 'Ship login',
  checks: { test: 'npm test' },
  team: {
    orchestrator: 'claude:opus',
    roles: { integrator: { agent: 'writer', model: 'claude:sonnet' } },
  },
  milestones: [
    {
      id: 'm1',
      tasks: [
        { key: 'a', title: 'Login', acceptance: ['users log in'] },
        { key: 'b', title: 'Skip *me*', acceptance: ['nothing'] },
      ],
    },
  ],
});

function mission(costUsd = 1.5) {
  return { id: 7, title: 'Mission', costUsd, approvedVersion: 2 };
}

function task(key: string, status: string): MissionTask {
  return {
    id: key === 'a' ? 1 : 2,
    missionId: 7,
    key,
    milestone: 'm1',
    status,
    branch: null,
    worktreePath: null,
    taskBase: null,
    runId: null,
    attempts: 1,
    notesJson: '[]',
    reportJson: status === 'skipped' ? JSON.stringify({ summary: 'not needed' }) : null,
    startedAt: null,
    finishedAt: null,
  };
}

function entry(id: number, kind: string, data: unknown): MissionEntry {
  return {
    id,
    missionId: 7,
    taskId: null,
    kind,
    notify: false,
    dataJson: JSON.stringify(data),
    createdAt: new Date(),
  };
}

describe('prBody', () => {
  it('writes every section', () => {
    const body = prBody(
      mission(),
      plan,
      [task('a', 'done'), task('b', 'skipped')],
      [
        entry(1, 'turn', {}),
        entry(2, 'checks', {
          results: [{ name: 'test', ok: true, durationMs: 42_000 }],
        }),
        entry(3, 'decision', {
          question: 'Where?',
          chosen: 'here',
          reason: 'because',
        }),
        entry(4, 'decision', {
          question: 'Perimetro',
          chosen: 'piano v3',
          reason: 'accepted',
          violations: [{ kind: 'path', file: 'x' }],
        }),
      ],
    );
    expect(body).toContain('## Goal');
    expect(body).toContain('- [x] **a** Login');
    expect(body).toContain('~~**b**~~');
    expect(body).toContain('| test | ✅ 42 s |');
    expect(body).toContain('**Where?** → here. because');
    expect(body).toContain('## Scope changes accepted');
    expect(body).toContain('Cost: $1.50');
    expect(body).toContain('Mission #7 · plan v2');
  });

  it('escapes markdown in titles and criteria', () => {
    const body = prBody(mission(), plan, [], []);
    expect(body).toContain('Skip \\*me\\*');
    expect(body).toContain('users log in');
  });

  it('truncates a very long body', () => {
    const long = { ...plan, goal: 'x'.repeat(70_000) } as typeof plan;
    const body = prBody(mission(), long, [], []);
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain('(truncated)');
  });
});
