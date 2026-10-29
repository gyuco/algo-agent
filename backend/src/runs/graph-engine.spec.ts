import { normalizeSteps, type StepSpec } from '../catalog/workflow-graph.js';
import type { Run } from '../generated/prisma/client.js';
import { runGraph, type Answer, type CommandOutcome, type StepPort } from './graph-engine.js';
import type { StepResult, StepResults } from './run-steps.js';
import type { RunEventData } from './run-types.js';
import type { CheckResult } from '../missions/checks.service.js';

const run = { id: 1, userId: 1, projectId: 1, input: '', stepsJson: '[]' } as Run;

const result = (
  name: 'build' | 'lint' | 'test',
  ok: boolean,
  output = '',
): CheckResult => ({
  name,
  argv: [name],
  ok,
  exitCode: ok ? 0 : 1,
  timedOut: false,
  durationMs: 1,
  output: output || (ok ? 'ok' : 'fallito'),
});

function rig(
  ports: Partial<StepPort> = {},
  options: {
    answers?: Record<string, string>;
    commands?: Record<string, CommandOutcome>;
  } = {},
) {
  const calls: string[] = [];
  const port: StepPort = {
    invoke: async function* (step, text): AsyncGenerator<RunEventData, Answer> {
      calls.push(`${step.id}:agent`);
      const output = options.answers?.[step.id] ?? `output ${step.id} ${text}`;
      if (!output) yield { type: 'text', text: '' };
      return { output, costUsd: 0.01, failed: false };
    },
    runCommands: async function* (step): AsyncGenerator<RunEventData, CommandOutcome> {
      calls.push(`${step.id}:run`);
      const outcome = options.commands?.[step.id] ?? { ok: true, results: [result('test', true)] };
      if (!outcome.ok) yield { type: 'text', text: '' };
      return outcome;
    },
    ...ports,
  };
  const steps: StepResults = {};
  const outcomes: RunEventData[] = [];
  const graph = async (specs: StepSpec[], saved: StepResults = {}) => {
    Object.assign(steps, saved);
    const generator = runGraph({
      run,
      input: 'INPUT',
      order: normalizeSteps(specs),
      steps,
      signal: new AbortController().signal,
      save: async () => undefined,
      port,
    });
    for (;;) {
      const next = await generator.next();
      if (next.done) return next.value;
      outcomes.push(next.value);
    }
  };
  return { port, calls, steps, outcomes, graph };
}

describe('graph engine run steps', () => {
  it('runs a command-only step and fails when expect pass is not met', async () => {
    const { graph, steps } = rig(
      {},
      {
        commands: {
          red: { ok: false, results: [result('test', false, 'rosso')] },
        },
      },
    );
    const outcome = await graph([{ id: 'red', run: ['test'], expect: 'pass' }]);
    expect(outcome).toBe('failed');
    expect(steps.red.status).toBe('failed');
    expect(steps.red.commands?.results[0].output).toBe('rosso');
  });

  it('passes a failing command with expect fail', async () => {
    const { graph, steps } = rig(
      {},
      {
        commands: {
          red: { ok: false, results: [result('test', false)] },
        },
      },
    );
    const outcome = await graph([{ id: 'red', run: ['test'], expect: 'fail' }]);
    expect(outcome).toBe('done');
    expect(steps.red.status).toBe('done');
  });

  it('fails a red step on a perimeter violation even though it expects a failure', async () => {
    const { graph, steps } = rig(
      {},
      {
        commands: {
          red: {
            ok: false,
            results: [result('test', false, 'fuori perimetro')],
            violation: true,
          },
        },
      },
    );
    const outcome = await graph([{ id: 'red', run: ['test'], expect: 'fail' }]);
    expect(outcome).toBe('failed');
    expect(steps.red.status).toBe('failed');
  });

  it('warns when tests already pass in a red step', async () => {    const { graph, steps } = rig(
      {},
      {
        commands: {
          red: { ok: true, results: [result('test', true)] },
        },
      },
    );
    const outcome = await graph([{ id: 'red', run: ['test'], expect: 'fail' }]);
    expect(outcome).toBe('done');
    expect(steps.red.warning).toContain('i test passano già');
  });

  it('does not call the agent when the commands of a composite check fail', async () => {
    const { graph, steps, calls } = rig(
      {},
      {
        commands: {
          verify: { ok: false, results: [result('test', false, 'guasto')] },
        },
      },
    );
    const outcome = await graph([
      { id: 'write', agent: 'a', prompt: 'P' },
      {
        id: 'verify',
        agent: 'reviewer',
        run: ['test'],
        verdict: ['ok', 'problemi'],
        needs: ['write'],
        prompt: 'V',
      },
    ]);
    expect(outcome).toBe('done');
    expect(calls).not.toContain('verify:agent');
    expect(steps.verify.verdict).toBe('problemi');
    expect(steps.verify.output).toContain('guasto');
  });

  it('stops at beforeCheck without commands nor agent', async () => {
    const { graph, steps, calls } = rig(
      {
        beforeCheck: async () => 'file protetti modificati',
      },
      {
        commands: { verify: { ok: true, results: [result('test', true)] } },
      },
    );
    const outcome = await graph([
      { id: 'write', agent: 'a', prompt: 'P' },
      {
        id: 'verify',
        agent: 'reviewer',
        run: ['test'],
        verdict: ['ok', 'problemi'],
        needs: ['write'],
        prompt: 'V',
      },
    ]);
    expect(outcome).toBe('done');
    expect(calls).not.toContain('verify:run');
    expect(calls).not.toContain('verify:agent');
    expect(steps.verify.review?.output).toContain('protetti');
  });

  it('calls the agent when commands and beforeCheck pass', async () => {
    const { graph, steps, calls } = rig(
      {},
      { answers: { verify: 'buono\nVERDETTO: ok' } },
    );
    const outcome = await graph([
      { id: 'write', agent: 'a', prompt: 'P' },
      {
        id: 'verify',
        agent: 'reviewer',
        run: ['test'],
        verdict: ['ok', 'problemi'],
        needs: ['write'],
        prompt: 'V',
      },
    ]);
    expect(outcome).toBe('done');
    expect(calls).toContain('verify:run');
    expect(calls).toContain('verify:agent');
    expect(steps.verify.verdict).toBe('ok');
    expect(steps.verify.commands?.ok).toBe(true);
  });
});

describe('graph engine repeat', () => {
  it('ends the block at once on a stop verdict', async () => {
    const { graph, steps } = rig(
      {},
      { answers: { check: 'VERDETTO: test_errati' } },
    );
    const outcome = await graph([
      {
        id: 'write',
        agent: 'a',
        prompt: 'P',
        repeat: {
          with: 'check',
          until: 'ok',
          max: 3,
          onMax: 'fail',
          stop: ['test_errati'],
        },
      },
      {
        id: 'check',
        agent: 'reviewer',
        needs: ['write'],
        verdict: ['ok', 'problemi', 'test_errati'],
        prompt: 'C',
      },
    ]);
    expect(outcome).toBe('failed');
    expect(steps.write.stopVerdict).toBe('test_errati');
    expect(steps.write.iterations).toHaveLength(1);
  });

  it('keeps the done steps of a resumed graph and runs the rest', async () => {
    const done: StepResults = {
      first: {
        agent: 'a',
        status: 'done',
        output: 'vecchio',
        costUsd: 0,
        startedAt: null,
        finishedAt: null,
      } satisfies StepResult,
    };
    const { graph, steps, calls } = rig();
    const outcome = await graph(
      [
        { id: 'first', agent: 'a', prompt: '{{input}}' },
        { id: 'second', agent: 'b', prompt: '{{steps.first}}' },
      ],
      done,
    );
    expect(outcome).toBe('done');
    expect(calls).toEqual(['second:agent']);
    expect(steps.first.output).toBe('vecchio');
    expect(steps.second.output).toContain('vecchio');
  });
});
