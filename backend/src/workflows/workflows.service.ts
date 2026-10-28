import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AgentRunnerService } from '../agents/agent-runner.service.js';
import { ProjectResourcesService } from '../agents/project-resources.service.js';
import type { WorkflowSpec } from '../catalog/catalog.js';
import { CatalogService } from '../catalog/catalog.service.js';
import {
  checksOf,
  fillPrompt,
  NO_CHECK_YET,
  normalizeSteps,
  sortSteps,
  type GraphStep,
} from '../catalog/workflow-graph.js';
import type { Run } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RunEventBus } from '../runs/run-event-bus.js';
import { RunHandlers } from '../runs/run-handlers.js';
import { RunLog } from '../runs/run-log.js';
import { RunQueueService } from '../runs/run-queue.service.js';
import {
  readSteps,
  type StepResult,
  type StepResults,
} from '../runs/run-steps.js';
import type {
  RunEventData,
  RunHandler,
  RunOutcome,
} from '../runs/run-types.js';
import { RunsService } from '../runs/runs.service.js';
import {
  parseVerdict,
  verdictInstruction,
  verdictReminder,
} from './verdict.js';

/** What the steps of a run share while it executes. */
interface Context {
  run: Run;
  project: { id: number; path: string };
  signal: AbortSignal;
  steps: StepResults;
  outputs: Record<string, string>;
  save: () => Promise<unknown>;
}

/** An agent's answer to one prompt. */
interface Answer {
  output: string;
  costUsd: number;
  failed: boolean;
  verdict?: string;
  sessionId?: string;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** The step's prompt the first time it runs, as an approval shows it. */
const firstPrompt = (
  step: GraphStep,
  input: string,
  outputs: Record<string, string>,
) =>
  step.repeat
    ? fillPrompt(
        step,
        input,
        { ...outputs, [step.repeat.with]: NO_CHECK_YET },
        1,
      )
    : fillPrompt(step, input, outputs);

/** Tells whether a workflow changed since a run of it was created. */
const hashOf = (workflow: WorkflowSpec) =>
  createHash('sha256').update(JSON.stringify(workflow)).digest('hex');

/**
 * Runs a workflow of the user's library: its steps one at a time, each after
 * the ones it needs and each a fresh agent session.
 */
@Injectable()
export class WorkflowsService implements RunHandler, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly catalogService: CatalogService,
    private readonly resources: ProjectResourcesService,
    private readonly runner: AgentRunnerService,
    private readonly handlers: RunHandlers,
    private readonly queue: RunQueueService,
    private readonly runsService: RunsService,
    private readonly log: RunLog,
    private readonly bus: RunEventBus,
  ) {}

  /** Steps of the runs executing now, which approvals change in place. */
  private readonly live = new Map<number, StepResults>();

  onModuleInit() {
    this.handlers.register('workflow', this);
  }

  async runs(userId: number, projectId: number) {
    await this.projects.get(userId, projectId);
    const runs = await this.prisma.run.findMany({
      where: { projectId, kind: 'workflow' },
      orderBy: { id: 'desc' },
      take: 20,
    });
    return runs.map((r) => this.runsService.view(r));
  }

  /**
   * The workflow, if the project has it on and every step's agent is usable;
   * checked up front rather than failing halfway through.
   */
  private async check(
    userId: number,
    project: { id: number; path: string },
    key: string,
  ) {
    const catalog = await this.catalogService.forUser(userId);
    const workflow = catalog.workflows.get(key);
    const enabled = await this.resources.isEnabled(project.id, catalog);
    if (!workflow || !enabled('workflow', key)) {
      throw new BadRequestException(
        `Il workflow ${key} non è disponibile in questo progetto`,
      );
    }
    let writes = false;
    let provider: string | null = null;
    for (const step of workflow.steps) {
      const checked = await this.runner.check({
        userId,
        project,
        agent: step.agent,
      });
      writes ||= checked.writes;
      provider ??= checked.provider;
    }
    return { workflow, writes, provider };
  }

  /** Queues a run of the workflow; it starts when the limits allow. */
  async create(userId: number, projectId: number, key: string, input: string) {
    const project = await this.projects.get(userId, projectId);
    const { workflow, writes, provider } = await this.check(
      userId,
      project,
      key,
    );
    const run = await this.queue.enqueue({
      projectId,
      userId,
      kind: 'workflow',
      title: key,
      input,
      workflow: key,
      workflowHash: hashOf(workflow),
      writes,
      provider,
    });
    return { runId: run.id, status: run.status };
  }

  /** Queues a run that keeps the steps `run` completed and redoes the rest. */
  async resume(run: Run) {
    const project = await this.projects.get(run.userId, run.projectId);
    const { workflow, writes, provider } = await this.check(
      run.userId,
      project,
      run.workflow!,
    );
    if (run.workflowHash && hashOf(workflow) !== run.workflowHash) {
      throw new ConflictException(
        'Il workflow è cambiato dopo questa esecuzione: avvialo di nuovo',
      );
    }
    const graph = normalizeSteps(workflow.steps);
    const kept: StepResults = {};
    for (const [id, step] of Object.entries(readSteps(run.stepsJson))) {
      if (step.status === 'done') kept[id] = step;
      // A block cut short goes on from its last full round, if any is left.
      const max = graph.find((s) => s.id === id)?.repeat?.max ?? 0;
      const rounds = step.iterations?.length ?? 0;
      if (step.status !== 'done' && rounds && rounds < max) {
        kept[id] = {
          agent: step.agent,
          status: 'pending',
          output: '',
          costUsd: 0,
          startedAt: null,
          finishedAt: null,
          iterations: step.iterations,
        };
      }
    }
    const resumed = await this.queue.enqueue({
      projectId: run.projectId,
      userId: run.userId,
      kind: 'workflow',
      trigger: run.trigger,
      title: run.title,
      input: run.input,
      workflow: run.workflow,
      workflowHash: hashOf(workflow),
      writes,
      provider,
      stepsJson: JSON.stringify(kept),
      resumeOf: run.id,
    });
    return { runId: resumed.id };
  }

  /**
   * Runs the steps whose dependencies are done, one at a time; a step that
   * repeats runs with its check as one block. A step that needs approval waits
   * for it while the others go on; once only such steps are left the run
   * returns `waiting`, and executes again when one is approved.
   */
  async *execute(
    run: Run,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, RunOutcome> {
    const project = await this.projects.get(run.userId, run.projectId);
    // Permissions as they are now, not as they were when it was queued.
    const { workflow } = await this.check(run.userId, project, run.workflow!);
    if (run.resumeOf && hashOf(workflow) !== run.workflowHash) {
      throw new ConflictException(
        'Il workflow è cambiato mentre la ripresa era in coda: avvialo di nuovo',
      );
    }

    // The catalog has already checked the graph, so it has an order.
    const order = sortSteps(normalizeSteps(workflow.steps))!;
    const byId = new Map(order.map((s) => [s.id, s]));
    const checks = checksOf(order);
    const steps: StepResults = readSteps(run.stepsJson);
    const outputs: Record<string, string> = {};
    for (const [id, step] of Object.entries(steps)) {
      if (step.status === 'done') outputs[id] = step.output;
    }
    // A resumed run shows the steps it kept; one back from waiting has them in its log.
    if (!(await this.prisma.runEvent.count({ where: { runId: run.id } }))) {
      for (const step of order) {
        const kept = steps[step.id];
        if (kept?.status !== 'done') continue;
        yield { type: 'step_started', id: step.id, agent: kept.agent };
        if (kept.output) yield { type: 'text', text: kept.output };
        yield { type: 'step_finished', id: step.id, status: kept.status };
      }
    }
    const ctx: Context = {
      run,
      project,
      signal,
      steps,
      outputs,
      save: () =>
        this.prisma.run.update({
          where: { id: run.id },
          data: { stepsJson: JSON.stringify(steps) },
        }),
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

    this.live.set(run.id, steps);
    let outcome: RunOutcome = 'failed';
    try {
      for (;;) {
        for (const step of ready()) {
          if (!step.approval || steps[step.id]?.approvedAt) continue;
          const prompt = firstPrompt(step, run.input, outputs);
          const { writes } = await this.runner.check({
            userId: run.userId,
            project,
            agent: step.agent,
          });
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
          await ctx.save();
          yield {
            type: 'approval_requested',
            id: step.id,
            agent: step.agent,
            prompt,
            writes,
          };
        }

        // Nothing awaits from here to the return, so no approval slips in between.
        const step = ready().find(
          (s) => !s.approval || steps[s.id]?.approvedAt,
        );
        if (!step) {
          const waiting = Object.values(steps).some(
            (s) => s.status === 'waiting_approval',
          );
          // From now on approvals go through the database.
          if (waiting) this.live.delete(run.id);
          outcome = waiting ? 'waiting' : 'done';
          return outcome;
        }

        const ok = step.repeat
          ? yield* this.runBlock(ctx, step, byId.get(step.repeat.with)!)
          : yield* this.runStep(ctx, step);
        if (!ok) return 'failed';
      }
    } finally {
      this.live.delete(run.id);
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
      await ctx.save();
    }
  }

  /** One session of `agent` on `text`, continuing `sessionId` when given. */
  private async *invoke(
    ctx: Context,
    agent: string,
    text: string,
    sessionId?: string,
  ): AsyncGenerator<RunEventData, Answer> {
    const answer: Answer = { output: '', costUsd: 0, failed: false };
    for await (const event of this.runner.run({
      userId: ctx.run.userId,
      project: ctx.project,
      agent,
      prompt: { text, attachments: [] },
      sessionId,
      signal: ctx.signal,
    })) {
      if (event.type === 'text') answer.output += event.text;
      if (event.type === 'session') answer.sessionId = event.sessionId;
      if (event.type === 'error') answer.failed = true;
      if (event.type === 'done') {
        answer.costUsd += event.costUsd;
        if (event.isError) answer.failed = true;
      }
      yield event;
    }
    if (ctx.signal.aborted) answer.failed = true;
    return answer;
  }

  /**
   * The step's answer to `prompt`. With verdicts, the verdict comes off the
   * answer; when it's missing, the agent is asked once more for that line alone.
   */
  private async *answer(
    ctx: Context,
    step: GraphStep,
    prompt: string,
  ): AsyncGenerator<RunEventData, Answer> {
    const values = step.verdict;
    const text = values ? prompt + verdictInstruction(values) : prompt;
    const first = yield* this.invoke(ctx, step.agent, text);
    if (first.failed || !values) return first;
    const parsed = parseVerdict(first.output, values);
    if (parsed.verdict) {
      return { ...first, output: parsed.text, verdict: parsed.verdict };
    }

    const retry = yield* this.invoke(
      ctx,
      step.agent,
      verdictReminder(values),
      first.sessionId,
    );
    const costUsd = first.costUsd + retry.costUsd;
    const again = parseVerdict(retry.output, values);
    if (retry.failed || !again.verdict) {
      if (!retry.failed) {
        yield {
          type: 'error',
          message: `Il passo ${step.id} non ha dato un verdetto valido (${values.join(', ')})`,
        };
      }
      return { ...first, costUsd, failed: true };
    }
    return { ...first, output: parsed.text, costUsd, verdict: again.verdict };
  }

  /** Runs a step once; false when it failed. */
  private async *runStep(
    ctx: Context,
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
    const answer = yield* this.answer(
      ctx,
      step,
      result.prompt ?? fillPrompt(step, ctx.run.input, ctx.outputs),
    );
    Object.assign(result, {
      output: answer.output,
      costUsd: answer.costUsd,
      verdict: answer.verdict,
    });
    ctx.outputs[step.id] = answer.output;
    return yield* this.finish(ctx, [step], answer.failed ? 'failed' : 'done');
  }

  /**
   * Runs a step and then its check, round after round, until the check gives
   * the verdict `until` or `max` rounds are done; false when the block failed.
   * A resumed block goes on after its last full round.
   */
  private async *runBlock(
    ctx: Context,
    step: GraphStep,
    check: GraphStep,
  ): AsyncGenerator<RunEventData, boolean> {
    const { until, max, onMax } = step.repeat!;
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
              ctx.run.input,
              { ...ctx.outputs, [check.id]: lastCheck },
              i,
            );
      const made = yield* this.answer(ctx, step, prompt);
      result.costUsd += made.costUsd;
      if (made.failed) return yield* this.finish(ctx, [step], 'failed');
      Object.assign(result, { output: made.output, verdict: made.verdict });
      ctx.outputs[step.id] = made.output;

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
      const verdict = yield* this.answer(
        ctx,
        check,
        fillPrompt(check, ctx.run.input, ctx.outputs, i),
      );
      checked.costUsd += verdict.costUsd;
      if (verdict.failed) {
        return yield* this.finish(ctx, [check, step], 'failed');
      }
      Object.assign(checked, {
        output: verdict.output,
        verdict: verdict.verdict,
      });
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
      if (verdict.verdict === until) {
        return yield* this.finish(ctx, [step, check], 'done');
      }
      checked.status = 'pending';
    }

    const outOfRounds = `${check.id} non ha dato "${until}" in ${max} iterazioni`;
    if (onMax === 'continue') {
      result.warning = `${outOfRounds}: si prosegue con l'ultima`;
      return yield* this.finish(ctx, [step, check], 'done');
    }
    yield { type: 'error', message: `Passo ${step.id}: ${outOfRounds}` };
    // The check did its job: it's the block that failed.
    yield* this.finish(ctx, [check], 'done');
    return yield* this.finish(ctx, [step], 'failed');
  }

  /** Closes the steps as `status`, unless already closed; true when it is `done`. */
  private async *finish(
    ctx: Context,
    finished: GraphStep[],
    status: 'done' | 'failed',
  ): AsyncGenerator<RunEventData, boolean> {
    const final = ctx.signal.aborted ? 'aborted' : status;
    for (const step of finished) {
      const result = ctx.steps[step.id];
      if (result.status !== 'running' && result.status !== 'pending') continue;
      result.status = final;
      result.finishedAt = new Date().toISOString();
      yield { type: 'step_finished', id: step.id, status: final };
    }
    await ctx.save();
    return final === 'done';
  }

  /** The run's step `stepId`, if it is waiting for approval. */
  private waitingStep(steps: StepResults, stepId: string) {
    const step = steps[stepId];
    if (!step) throw new NotFoundException('Passo non trovato');
    if (step.status !== 'waiting_approval') {
      throw new ConflictException('Il passo non attende approvazione');
    }
    return step;
  }

  /**
   * Lets a step waiting for approval run. The workflow must be the one the run
   * started with, and its agents still usable, as when the run was created.
   */
  async approve(userId: number, runId: number, stepId: string) {
    const run = await this.runsService.find(userId, runId);
    if (run.kind !== 'workflow')
      throw new NotFoundException('Passo non trovato');
    const project = await this.projects.get(userId, run.projectId);
    const { workflow } = await this.check(userId, project, run.workflow!);
    if (hashOf(workflow) !== run.workflowHash) {
      throw new ConflictException(
        "Il workflow è cambiato durante l'attesa: rifiuta il passo e avvia una nuova esecuzione",
      );
    }
    const approvedAt = new Date().toISOString();

    // Still executing: the run picks the step up when it's next ready.
    const live = this.live.get(runId);
    if (live) {
      Object.assign(this.waitingStep(live, stepId), {
        status: 'pending',
        approvedAt,
      });
      return;
    }

    const current = await this.prisma.run.findUniqueOrThrow({
      where: { id: runId },
    });
    const steps = readSteps(current.stepsJson);
    Object.assign(this.waitingStep(steps, stepId), {
      status: 'pending',
      approvedAt,
    });
    // Only from waiting, and only if no other approval changed the steps meanwhile.
    const { count } = await this.prisma.run.updateMany({
      where: { id: runId, status: 'waiting', stepsJson: current.stepsJson },
      data: { status: 'queued', stepsJson: JSON.stringify(steps) },
    });
    if (!count) {
      throw new ConflictException(
        "L'esecuzione sta cambiando stato: riprova tra poco",
      );
    }
    this.bus.notify(userId, { type: 'changed', runId });
    this.queue.wake();
  }

  /** Rejects a step waiting for approval: the run ends as aborted. */
  async reject(userId: number, runId: number, stepId: string, note?: string) {
    const run = await this.runsService.find(userId, runId);
    if (run.kind !== 'workflow')
      throw new NotFoundException('Passo non trovato');
    const finishedAt = new Date().toISOString();
    const rejected = { status: 'aborted' as const, finishedAt, note };

    const live = this.live.get(runId);
    if (live) {
      Object.assign(this.waitingStep(live, stepId), rejected);
      await this.runsService.abort(userId, runId);
      return;
    }

    const steps = readSteps(run.stepsJson);
    Object.assign(this.waitingStep(steps, stepId), rejected);
    const reason = note
      ? `Passo ${stepId} rifiutato: ${note}`
      : `Passo ${stepId} rifiutato`;
    if (
      !(await this.log.close(run, ['waiting', 'queued'], 'aborted', reason))
    ) {
      throw new ConflictException(
        "L'esecuzione sta cambiando stato: riprova tra poco",
      );
    }
    // Closed: nothing else writes its steps any more.
    await this.prisma.run.update({
      where: { id: runId },
      data: { stepsJson: JSON.stringify(steps) },
    });
  }
}
