import { listSteps, readSteps, type StepResults } from './run-steps.js';

describe('readSteps', () => {
  it('reads the list older runs saved as steps by id', () => {
    const steps = readSteps(
      JSON.stringify([
        { agent: 'reviewer', output: 'one', isError: false, complete: true },
        { agent: 'writer', output: 'two', isError: true },
        { agent: 'writer', output: 'thr', isError: false, complete: false },
      ]),
    );
    expect(
      Object.entries(steps).map(([id, s]) => [id, s.agent, s.status]),
    ).toEqual([
      ['step-1', 'reviewer', 'done'],
      ['step-2', 'writer', 'failed'],
      ['step-3', 'writer', 'aborted'],
    ]);
  });
});

describe('listSteps', () => {
  it('lists the steps in the order they started', () => {
    const at = (startedAt: string) => ({
      agent: 'a',
      status: 'done' as const,
      output: '',
      costUsd: 0,
      startedAt,
      finishedAt: null,
    });
    const steps: StepResults = {
      fix: at('2026-01-01T00:00:02Z'),
      '7': at('2026-01-01T00:00:01Z'),
    };
    expect(listSteps(steps).map((s) => s.id)).toEqual(['7', 'fix']);
  });
});
