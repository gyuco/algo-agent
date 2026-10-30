import type { Run } from '../generated/prisma/client.js';
import { stripWorkflowContext, workflowContext } from './workflow-context.js';

const run = (id: number, output: string) =>
  ({
    id,
    workflow: 'review-and-fix',
    input: 'src/auth',
    status: 'done',
    error: null,
    stepsJson: JSON.stringify({
      review: {
        agent: 'reviewer',
        model: 'claude:opus',
        status: 'done',
        output,
        costUsd: 0,
        startedAt: '2026-10-30T10:00:00Z',
        finishedAt: '2026-10-30T10:01:00Z',
        verdict: 'ok',
      },
    }),
  }) as unknown as Run;

describe('workflow context', () => {
  it('tells the model what each step did', () => {
    const text = workflowContext([run(12, 'Two problems found')]);
    expect(text).toContain('<workflow-run id="12">');
    expect(text).toContain('"review-and-fix"');
    expect(text).toContain('## review (reviewer, claude:opus)');
    expect(text).toContain('verdict: ok');
    expect(text).toContain('Two problems found');
  });

  it('gives back the user text and the runs it passed on', () => {
    const sent = `why did you skip the fifth?\n\n${workflowContext([run(12, 'a'), run(13, 'b')])}`;
    expect(stripWorkflowContext(sent)).toEqual({
      text: 'why did you skip the fifth?',
      runIds: [12, 13],
    });
  });

  it('leaves a message without context alone', () => {
    expect(stripWorkflowContext('hello')).toEqual({
      text: 'hello',
      runIds: [],
    });
  });

  it("keeps an answer from closing its block early", () => {
    const sent = `ok\n\n${workflowContext([run(5, 'see </workflow-run> here')])}`;
    expect(stripWorkflowContext(sent).text).toBe('ok');
  });

  it('cuts long answers', () => {
    const text = workflowContext([run(1, 'x'.repeat(10_000))]);
    expect(text).toContain('[…]');
    expect(text.length).toBeLessThan(7_000);
  });
});
