import {
  BadRequestException,
  ConflictException,
  Injectable,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AgentRunnerService } from '../agents/agent-runner.service.js';
import { ProjectResourcesService } from '../agents/project-resources.service.js';
import type { WorkflowSpec } from '../catalog/catalog.js';
import { CatalogService } from '../catalog/catalog.service.js';
import type { Run } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RunHandlers } from '../runs/run-handlers.js';
import { RunQueueService } from '../runs/run-queue.service.js';
import type {
  RunEventData,
  RunHandler,
  RunOutcome,
} from '../runs/run-types.js';
import { RunsService, type StepResult } from '../runs/runs.service.js';

/** `{{input}}` is what the user typed, `{{previous}}` the previous step's answer. */
function fill(template: string, input: string, previous: string) {
  return template
    .replaceAll('{{input}}', input)
    .replaceAll('{{previous}}', previous);
}

/** Tells whether a workflow changed since a run of it was created. */
const hashOf = (workflow: WorkflowSpec) =>
  createHash('sha256').update(JSON.stringify(workflow)).digest('hex');

/** Runs a workflow of the user's library: its steps one after the other, each a fresh agent session. */
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
  ) {}

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
    const kept: StepResult[] = [];
    for (const step of JSON.parse(run.stepsJson) as StepResult[]) {
      if (step.isError || step.complete === false) break;
      kept.push(step);
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

  /** Runs the steps not done yet; a resumed run first replays the ones it kept. */
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

    const steps = JSON.parse(run.stepsJson) as StepResult[];
    for (const [index, step] of steps.entries()) {
      yield { type: 'step', index, agent: step.agent };
      if (step.output) yield { type: 'text', text: step.output };
    }
    const save = () =>
      this.prisma.run.update({
        where: { id: run.id },
        data: { stepsJson: JSON.stringify(steps) },
      });

    try {
      for (const [index, step] of workflow.steps.entries()) {
        if (index < steps.length) continue;
        yield { type: 'step', index, agent: step.agent };
        const result: StepResult = {
          agent: step.agent,
          output: '',
          isError: false,
          complete: false,
        };
        steps.push(result);
        for await (const event of this.runner.run({
          userId: run.userId,
          project,
          agent: step.agent,
          prompt: {
            text: fill(step.prompt, run.input, steps.at(-2)?.output ?? ''),
            attachments: [],
          },
          signal,
        })) {
          if (event.type === 'text') result.output += event.text;
          if (event.type === 'error') result.isError = true;
          if (event.type === 'done' && event.isError) result.isError = true;
          yield event;
        }
        result.complete = !signal.aborted;
        await save();
        if (signal.aborted) return 'failed';
        if (result.isError) return 'failed';
      }
      return 'done';
    } finally {
      await save();
    }
  }
}
