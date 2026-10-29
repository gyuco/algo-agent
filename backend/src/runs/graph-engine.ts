import type { Run } from '../generated/prisma/client.js';
import {
  checksOf,
  fillPrompt,
  NO_CHECK_YET,
  type GraphStep,
} from '../catalog/workflow-graph.js';
import type { CheckResult } from '../missions/checks.service.js';
import {
  parseVerdict,
  verdictInstruction,
  verdictReminder,
} from '../workflows/verdict.js';
import type { StepResult, StepResults } from './run-steps.js';
import type { RunEventData, RunOutcome } from './run-types.js';

/** An agent's answer to one prompt. */
export interface Answer {
  output: string;
  costUsd: number;
  failed: boolean;
  /** Why it failed, when the agent said so (e.g. the provider's error). */
  error?: string;
  verdict?: string;
  sessionId?: string;
}

/** The outcome of the commands of a step. */
export interface CommandOutcome {
  ok: boolean;
  results: CheckResult[];
  /** The perimeter was violated: the step fails even when it expects a failure. */
  violation?: boolean;
}

/**
 * What the engine needs from whoever runs the steps: the agent sessions, the
 * commands, the checks before a verification, and the checkpoint after a write.
 * Workflows implement the first and the approval hook; task runs implement all.
 */
export interface StepPort {
  /** One session of the step's agent on `text`, continuing `sessionId` when given. */
  invoke(
    step: GraphStep,
    text: string,
    sessionId?: string,
  ): AsyncGenerator<RunEventData, Answer>;
  /** A step with `run`: executes the plan's commands; absent when unsupported. */
  runCommands?(step: GraphStep): AsyncGenerator<RunEventData, CommandOutcome>;
  /** Before a verification: `protect` and perimeter. Non-null means verdict `problemi`. */
  beforeCheck?(
    check: GraphStep,
    writer: GraphStep,
    emit: (event: RunEventData) => void,
  ): Promise<string | null>;
  /** After a step that writes: a checkpoint commit, or null when nothing changed. */
  afterWrite?(step: GraphStep): Promise<string | null>;
  /** Before a step: false stops here in `waiting` (budget, later phase). */
  mayStart?(step: GraphStep): Promise<boolean>;
  /** What an approval asks the user: only the workflow engine uses it. */
  approval?(step: GraphStep): Promise<{ writes: boolean }>;
}

/** What the steps of a graph share while it executes. */
export interface GraphContext {
  run: Run;
  input: string;
  signal: AbortSignal;
  order: GraphStep[];
  steps: StepResults;
  outputs: Record<string, string>;
  save: () => Promise<unknown>;
  port: StepPort;
}

export interface GraphRequest {
  run: Run;
  input: string;
  /** The steps in an order their `needs` allow. */
  order: GraphStep[];
  steps: StepResults;
  signal: AbortSignal;
  save: () => Promise<unknown>;
  port: StepPort;
  /** Steps already done are announced again when the run has no log yet. */
  replay?: boolean;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** The step's prompt the first time it runs, as an approval shows it. */
export function firstPrompt(
  step: GraphStep,
  input: string,
  outputs: Record<string, string>,
) {
  return step.repeat
    ? fillPrompt(step, input, { ...outputs, [step.repeat.with]: NO_CHECK_YET }, 1)
    : fillPrompt(step, input, outputs);
}

/** A readable summary of the commands' outcome, for a verdict and the report. */
export function commandsText(outcome: CommandOutcome) {
  return outcome.results
    .map(
      (r) =>
        `${r.name}: ${r.ok ? 'ok' : 'fallito'} (exit ${r.exitCode ?? '?'}${r.timedOut ? ', timeout' : ''})${
          r.output ? `\n${r.output}` : ''
        }`,
    )
    .join('\n');
}

/**
 * Runs a graph of steps: the ready ones in order, a step that repeats as one
 * block with its check, a step that needs approval waiting for it. The caller
 * supplies the steps already run, so an interrupted graph goes on from them.
 */
export async function* runGraph(
  request: GraphRequest,
): AsyncGenerator<RunEventData, RunOutcome> {
  const { order, signal, port } = request;
  const byId = new Map(order.map((s) => [s.id, s]));
  const checks = checksOf(order);
  const steps = request.steps;
  const outputs: Record<string, string> = {};
  for (const [id, step] of Object.entries(steps)) {
    if (step.status === 'done') outputs[id] = step.output;
  }

  const save = () => request.save();
  const ctx: GraphContext = {
    run: request.run,
    input: request.input,
    signal,
    order,
    steps,
    outputs,
    save,
    port,
  };

  /** Steps not started whose dependencies are all done; checks run inside their block. */
  const ready = () =>
    order.filter((step) => {
      const status = steps[step.id]?.status;
      return (
        (!status || status === 'pending') &&
        !checks.has(step.id) &&
        step.needs.every((n) => steps[n]?.status === 'done')
      );
    });

  let outcome: RunOutcome = 'failed';
  try {
    for (;;) {
      for (const step of ready()) {
        if (!step.approval || steps[step.id]?.approvedAt) continue;
        const prompt = firstPrompt(step, request.input, outputs);
        const { writes } = (await port.approval?.(step)) ?? { writes: false };
        steps[step.id] = {
          ...steps[step.id],
          agent: step.agent,
          status: 'waiting_approval',
          output: '',
          costUsd: 0,
          startedAt: null,
          finishedAt: null,
          prompt,
          writes,
          requestedAt: new Date().toISOString(),
        };
        await save();
        yield {
          type: 'approval_requested',
          id: step.id,
          agent: step.agent,
          prompt,
          writes,
        };
      }

      const step = ready().find(
        (s) => !s.approval || steps[s.id]?.approvedAt,
      );
      if (!step) {
        const waiting = Object.values(steps).some(
          (s) => s.status === 'waiting_approval',
        );
        outcome = waiting ? 'waiting' : 'done';
        return outcome;
      }
      if (port.mayStart && !(await port.mayStart(step))) {
        yield { type: 'budget_wait' };
        outcome = 'waiting';
        return outcome;
      }

      const ok = step.repeat
        ? yield* runBlock(ctx, step, byId.get(step.repeat.with)!)
        : yield* runStep(ctx, step);
      if (!ok) return 'failed';
    }
  } finally {
    const now = new Date().toISOString();
    for (const result of Object.values(steps)) {
      // A step left running was cut short by an error or a stop.
      if (result.status === 'running') {
        result.status = signal.aborted ? 'aborted' : 'failed';
        result.finishedAt = now;
      }
      // A run that ends doesn't get to the steps still waiting.
      if (outcome === 'failed' && result.status === 'waiting_approval') {
        result.status = 'aborted';
        result.finishedAt = now;
      }
    }
    await save();
  }
}

/** The step a verification belongs to: the one whose block it checks. */
function writerOf(order: GraphStep[], check: GraphStep) {
  return order.find((s) => s.repeat?.with === check.id) ?? check;
}

/**
 * The check of a repeat block, or a step with `run`: perimeter and commands
 * first, then the agent. A failing command gives `problemi` without asking the
 * agent; `expect: fail` succeeds when the command fails.
 */
async function* verify(
  ctx: GraphContext,
  step: GraphStep,
  writer: GraphStep,
  prompt: string,
): AsyncGenerator<RunEventData, Answer & { commands?: CommandOutcome }> {
  const pending: RunEventData[] = [];
  const emit = (event: RunEventData) => pending.push(event);
  let commands: CommandOutcome | undefined;
  if (step.run?.length && ctx.port.runCommands) {
    // Protect and perimeter guard a verification, not a run-only step.
    const violation =
      step.agent && ctx.port.beforeCheck
        ? await ctx.port.beforeCheck(step, writer, emit)
        : null;
    while (pending.length) yield pending.shift()!;
    if (violation !== null) {
      return {
        output: violation,
        costUsd: 0,
        failed: false,
        verdict: 'problemi',
      };
    }
    commands = yield* ctx.port.runCommands(step);
    const failed =
      commands.violation === true
        ? true
        : step.expect === 'fail'
          ? commands.ok
          : !commands.ok;
    if (failed) {
      const output = commandsText(commands);
      return {
        output,
        costUsd: 0,
        failed: false,
        verdict: 'problemi',
        commands,
      };
    }
  }
  if (!step.agent) {
    return { output: commands ? commandsText(commands) : '', costUsd: 0, failed: false, commands };
  }
  const answer = yield* answerOf(ctx, step, prompt);
  return { ...answer, commands };
}

/** Runs a step once; false when it failed. */
async function* runStep(
  ctx: GraphContext,
  step: GraphStep,
): AsyncGenerator<RunEventData, boolean> {
  yield { type: 'step_started', id: step.id, agent: step.agent };
  const result: StepResult = {
    ...ctx.steps[step.id],
    agent: step.agent,
    status: 'running',
    output: '',
    costUsd: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  ctx.steps[step.id] = result;

  const prompt = result.prompt ?? fillPrompt(step, ctx.input, ctx.outputs);
  const answer = yield* verify(ctx, step, writerOf(ctx.order, step), prompt);
  Object.assign(result, {
    output: answer.output,
    costUsd: answer.costUsd,
    verdict: answer.verdict,
    ...(answer.commands ? { commands: answer.commands } : {}),
    ...(answer.verdict
      ? { review: { verdict: answer.verdict, output: answer.output } }
      : {}),
  });
  ctx.outputs[step.id] = answer.output;

  if (step.agent && ctx.port.afterWrite) {
    const checkpoint = await ctx.port.afterWrite(step);
    if (checkpoint) result.checkpoint = checkpoint;
  }

  if (step.run?.length) {
    // A run-only step is judged by its commands.
    const outcome = answer.commands;
    if (step.expect === 'fail' && outcome?.ok && !step.agent) {
      result.warning = 'i test passano già';
    }
    const ok = !step.agent
      ? outcome?.violation
        ? false
        : step.expect === 'fail'
          ? true
          : (outcome?.ok ?? false)
      : true;
    if (!ok) {
      yield { type: 'error', message: `Passo ${step.id}: i comandi non hanno l'esito atteso` };
    }
    return yield* finish(ctx, [step], ok ? 'done' : 'failed');
  }

  if (answer.error) result.error = answer.error;
  return yield* finish(ctx, [step], answer.failed ? 'failed' : 'done');
}

/**
 * Runs a step and then its check, round after round, until the check gives
 * the verdict `until` or `max` rounds are done; false when the block failed.
 * A resumed block goes on after its last full round.
 */
async function* runBlock(
  ctx: GraphContext,
  step: GraphStep,
  check: GraphStep,
): AsyncGenerator<RunEventData, boolean> {
  const { until, max, onMax, stop } = step.repeat!;
  const now = () => new Date().toISOString();
  const iterations = ctx.steps[step.id]?.iterations ?? [];
  const result: StepResult = {
    ...ctx.steps[step.id],
    agent: step.agent,
    status: 'running',
    output: '',
    costUsd: sum(iterations.map((r) => r.costUsd)),
    startedAt: now(),
    finishedAt: null,
    iterations,
  };
  const checked: StepResult = {
    agent: check.agent,
    status: 'pending',
    output: '',
    costUsd: sum(iterations.map((r) => r.check.costUsd)),
    startedAt: null,
    finishedAt: null,
  };
  ctx.steps[step.id] = result;
  ctx.steps[check.id] = checked;
  yield { type: 'step_started', id: step.id, agent: step.agent };

  let last = iterations.at(-1);
  for (let i = iterations.length + 1; i <= max; i++) {
    yield {
      type: 'iteration_started',
      id: step.id,
      agent: step.agent,
      iteration: i,
      max,
    };
    const lastCheck = last?.check.output ?? NO_CHECK_YET;
    const prompt =
      i === 1 && result.prompt
        ? result.prompt
        : fillPrompt(
            step,
            ctx.input,
            { ...ctx.outputs, [check.id]: lastCheck },
            i,
          );
    const made = yield* answerOf(ctx, step, prompt);
    result.costUsd += made.costUsd;
    if (made.failed) {
      if (made.error) result.error = made.error;
      return yield* finish(ctx, [step], 'failed');
    }
    Object.assign(result, { output: made.output, verdict: made.verdict });
    ctx.outputs[step.id] = made.output;

    if (ctx.port.afterWrite) {
      const checkpoint = await ctx.port.afterWrite(step);
      if (checkpoint) result.checkpoint = checkpoint;
    }

    if (!checked.startedAt) {
      checked.startedAt = now();
      yield { type: 'step_started', id: check.id, agent: check.agent };
    }
    checked.status = 'running';
    yield {
      type: 'iteration_started',
      id: check.id,
      agent: check.agent,
      iteration: i,
      max,
    };
    const verdict = yield* verify(
      ctx,
      check,
      step,
      fillPrompt(check, ctx.input, ctx.outputs, i),
    );
    checked.costUsd += verdict.costUsd;
    if (verdict.failed) {
      if (verdict.error) checked.error = verdict.error;
      return yield* finish(ctx, [check, step], 'failed');
    }
    Object.assign(checked, {
      output: verdict.output,
      verdict: verdict.verdict,
      ...(verdict.commands ? { commands: verdict.commands } : {}),
    });
    if (verdict.commands) result.commands = verdict.commands;
    ctx.outputs[check.id] = verdict.output;
    last = {
      output: made.output,
      verdict: made.verdict,
      costUsd: made.costUsd,
      check: {
        output: verdict.output,
        verdict: verdict.verdict!,
        costUsd: verdict.costUsd,
      },
    };
    iterations.push(last);
    await ctx.save();

    const value = verdict.verdict ?? '';
    if (stop.includes(value)) {
      result.stopVerdict = value;
      result.warning = `La verifica ha dato "${value}": il blocco si ferma`;
      yield {
        type: 'error',
        message: `Passo ${step.id}: la verifica ha dato "${value}"`,
      };
      yield* finish(ctx, [check], 'done');
      return yield* finish(ctx, [step], 'failed');
    }
    if (value === until) {
      return yield* finish(ctx, [step, check], 'done');
    }
    checked.status = 'pending';
  }

  const outOfRounds = `${check.id} non ha dato "${until}" in ${max} iterazioni`;
  if (onMax === 'continue') {
    result.warning = `${outOfRounds}: si prosegue con l'ultima`;
    return yield* finish(ctx, [step, check], 'done');
  }
  yield { type: 'error', message: `Passo ${step.id}: ${outOfRounds}` };
  // The check did its job: it's the block that failed.
  yield* finish(ctx, [check], 'done');
  return yield* finish(ctx, [step], 'failed');
}

/**
 * The step's answer to `prompt`. With verdicts, the verdict comes off the
 * answer; when it's missing, the agent is asked once more for that line alone.
 */
async function* answerOf(
  ctx: GraphContext,
  step: GraphStep,
  prompt: string,
): AsyncGenerator<RunEventData, Answer> {
  const values = step.verdict;
  const text = values ? prompt + verdictInstruction(values) : prompt;
  const first = yield* ctx.port.invoke(step, text);
  if (first.failed || !values) return first;
  const parsed = parseVerdict(first.output, values);
  if (parsed.verdict) {
    return { ...first, output: parsed.text, verdict: parsed.verdict };
  }

  const retry = yield* ctx.port.invoke(
    step,
    verdictReminder(values),
    first.sessionId,
  );
  const costUsd = first.costUsd + retry.costUsd;
  const again = parseVerdict(retry.output, values);
  if (retry.failed || !again.verdict) {
    const error =
      retry.error ??
      `Il passo ${step.id} non ha dato un verdetto valido (${values.join(', ')})`;
    if (!retry.failed) yield { type: 'error', message: error };
    return { ...first, costUsd, failed: true, error };
  }
  return { ...first, output: parsed.text, costUsd, verdict: again.verdict };
}

/** Closes the steps as `status`, unless already closed; true when it is `done`. */
async function* finish(
  ctx: GraphContext,
  finished: GraphStep[],
  status: 'done' | 'failed',
): AsyncGenerator<RunEventData, boolean> {
  const final = ctx.signal.aborted ? 'aborted' : status;
  for (const step of finished) {
    const result = ctx.steps[step.id];
    if (!result) continue;
    if (result.status !== 'running' && result.status !== 'pending') continue;
    result.status = final;
    result.finishedAt = new Date().toISOString();
    yield { type: 'step_finished', id: step.id, status: final };
  }
  await ctx.save();
  return final === 'done';
}
