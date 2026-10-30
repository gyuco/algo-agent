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
  normalizeSteps,
  sortSteps,
  type GraphStep,
} from '../catalog/workflow-graph.js';
import type { Run } from '../generated/prisma/client.js';
import { ACTIVE_STATUSES } from '../runs/run-types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { runGraph, type Answer, type StepPort } from '../runs/graph-engine.js';
import { RunEventBus } from '../runs/run-event-bus.js';
import { RunHandlers } from '../runs/run-handlers.js';
import { RunLog } from '../runs/run-log.js';
import { RunQueueService } from '../runs/run-queue.service.js';
import { readSteps, type StepResults } from '../runs/run-steps.js';
import type {
  RunEventData,
  RunHandler,
  RunOutcome,
} from '../runs/run-types.js';
import { RunsService } from '../runs/runs.service.js';

/** Tells whether a workflow changed since a run of it was created. */
const hashOf = (workflow: WorkflowSpec) =>
  createHash('sha256').update(JSON.stringify(workflow)).digest('hex');

/** Who fills one of the agents a workflow names, for one run. */
export interface Assignment {
  agent: string;
  model?: string;
  effort?: string;
}

/** By slot: the agent key the workflow names. Slots left out keep their agent. */
export type Assignments = Record<string, Assignment>;

/** What a workflow run keeps in `specJson`. */
interface WorkflowRunSpec {
  assign?: Assignments;
}

function readAssignments(run: Run): Assignments {
  return run.specJson
    ? ((JSON.parse(run.specJson) as WorkflowRunSpec).assign ?? {})
    : {};
}

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
    assign: Assignments = {},
  ) {
    const catalog = await this.catalogService.forProject(userId, project.id);
    const workflow = catalog.workflows.get(key);
    const enabled = await this.resources.isEnabled(project.id, catalog);
    if (!workflow || !enabled('workflow', key)) {
      throw new BadRequestException(
        `Il workflow ${key} non è disponibile in questo progetto`,
      );
    }
    if (workflow.task) {
      throw new BadRequestException(
        'È un modello di task: si usa solo nelle missioni',
      );
    }
    const slots = new Set(workflow.steps.map((s) => s.agent));
    const unknown = Object.keys(assign).filter((slot) => !slots.has(slot));
    if (unknown.length) {
      throw new BadRequestException(
        `Il workflow ${key} non usa gli agenti ${unknown.join(', ')}`,
      );
    }
    let writes = false;
    let provider: string | null = null;
    for (const step of workflow.steps) {
      const chosen = step.agent ? assign[step.agent] : undefined;
      const checked = await this.runner.check({
        userId,
        project,
        agent: chosen?.agent ?? step.agent,
        model: chosen?.model,
      });
      writes ||= checked.writes;
      provider ??= checked.provider;
    }
    return { workflow, writes, provider };
  }

  /**
   * Queues a run of the workflow; it starts when the limits allow. In a chat
   * conversation it waits for no turn: one at a time, like the chat's own.
   */
  async create(
    userId: number,
    projectId: number,
    key: string,
    request: { input: string; sessionId?: string; assign?: Assignments },
  ) {
    const project = await this.projects.get(userId, projectId);
    const assign = request.assign ?? {};
    const { workflow, writes, provider } = await this.check(
      userId,
      project,
      key,
      assign,
    );
    if (request.sessionId) {
      const busy = await this.prisma.run.count({
        where: {
          userId,
          kind: { in: ['chat', 'workflow'] },
          sessionId: request.sessionId,
          status: { in: ACTIVE_STATUSES },
        },
      });
      if (busy) {
        throw new ConflictException(
          'Questa conversazione ha già una risposta in corso',
        );
      }
    }
    const spec: WorkflowRunSpec = { assign };
    const run = await this.queue.enqueue({
      projectId,
      userId,
      kind: 'workflow',
      title: key,
      input: request.input,
      workflow: key,
      workflowHash: hashOf(workflow),
      sessionId: request.sessionId ?? null,
      specJson: JSON.stringify(spec),
      writes,
      provider,
    });
    return { runId: run.id, status: run.status };
  }

  /** Queues a run that keeps the steps `run` completed and redoes the rest. */
  async resume(run: Run) {
    const project = await this.projects.get(run.userId, run.projectId!);
    const { workflow, writes, provider } = await this.check(
      run.userId,
      project,
      run.workflow!,
      readAssignments(run),
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
      projectId: run.projectId!,
      userId: run.userId,
      kind: 'workflow',
      trigger: run.trigger,
      title: run.title,
      input: run.input,
      workflow: run.workflow,
      workflowHash: hashOf(workflow),
      sessionId: run.sessionId,
      specJson: run.specJson,
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
    const project = await this.projects.get(run.userId, run.projectId!);
    const assign = readAssignments(run);
    // Permissions as they are now, not as they were when it was queued.
    const { workflow } = await this.check(
      run.userId,
      project,
      run.workflow!,
      assign,
    );
    if (run.resumeOf && hashOf(workflow) !== run.workflowHash) {
      throw new ConflictException(
        'Il workflow è cambiato mentre la ripresa era in coda: avvialo di nuovo',
      );
    }

    // The catalog has already checked the graph, so it has an order. Each step
    // runs with the agent its slot was given; the slot stays as its role.
    const slotOf = new Map<string, string>();
    const order = sortSteps(normalizeSteps(workflow.steps))!.map((step) => {
      const chosen = step.agent ? assign[step.agent] : undefined;
      if (!chosen) return step;
      slotOf.set(step.id, step.agent!);
      return { ...step, agent: chosen.agent };
    });
    const assigned = (step: GraphStep) => {
      const slot = slotOf.get(step.id);
      return slot ? { slot, ...assign[slot] } : undefined;
    };
    const steps: StepResults = readSteps(run.stepsJson);
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

    const save = () =>
      this.prisma.run.update({
        where: { id: run.id },
        data: { stepsJson: JSON.stringify(steps) },
      });
    const port: StepPort = {
      invoke: (step: GraphStep, text: string, sessionId?: string) =>
        this.invoke(run, project, signal, step.agent, text, sessionId, {
          model: assigned(step)?.model,
          effort: assigned(step)?.effort,
        }),
      describe: (step: GraphStep) => {
        const chosen = assigned(step);
        return chosen ? { model: chosen.model, role: chosen.slot } : {};
      },
      approval: async (step: GraphStep) => ({
        writes: (
          await this.runner.check({
            userId: run.userId,
            project,
            agent: step.agent,
            model: assigned(step)?.model,
          })
        ).writes,
      }),
    };

    this.live.set(run.id, steps);
    try {
      return yield* runGraph({
        run,
        input: run.input,
        order,
        steps,
        signal,
        save,
        port,
      });
    } finally {
      this.live.delete(run.id);
    }
  }

  /** One session of `agent` on `text`, continuing `sessionId` when given, with the model its slot was given. */
  private async *invoke(
    run: Run,
    project: { id: number; path: string },
    signal: AbortSignal,
    agent: string,
    text: string,
    sessionId?: string,
    chosen: { model?: string; effort?: string } = {},
  ): AsyncGenerator<RunEventData, Answer> {
    const answer: Answer = { output: '', costUsd: 0, failed: false };
    for await (const event of this.runner.run({
      userId: run.userId,
      project,
      agent,
      prompt: { text, attachments: [] },
      sessionId,
      model: chosen.model,
      effort: chosen.effort,
      signal,
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
    if (signal.aborted) answer.failed = true;
    return answer;
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
    const project = await this.projects.get(userId, run.projectId!);
    const { workflow } = await this.check(
      userId,
      project,
      run.workflow!,
      readAssignments(run),
    );
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
