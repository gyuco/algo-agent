import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AgentRunnerService,
  type ChatEvent,
} from '../agents/agent-runner.service.js';
import { ProjectResourcesService } from '../agents/project-resources.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';

export type RunStatus = 'running' | 'done' | 'failed' | 'aborted';

export interface StepResult {
  agent: string;
  output: string;
  isError: boolean;
}

export type WorkflowEvent =
  | { type: 'run'; runId: number }
  | { type: 'step'; index: number; agent: string }
  | ChatEvent
  | { type: 'finished'; status: RunStatus };

/** `{{input}}` is what the user typed, `{{previous}}` the previous step's answer. */
function fill(template: string, input: string, previous: string) {
  return template
    .replaceAll('{{input}}', input)
    .replaceAll('{{previous}}', previous);
}

/** Runs a workflow of the user's library: its steps one after the other, each a fresh agent session. */
@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly catalogService: CatalogService,
    private readonly resources: ProjectResourcesService,
    private readonly runner: AgentRunnerService,
  ) {}

  async runs(userId: number, projectId: number) {
    await this.projects.get(userId, projectId);
    const runs = await this.prisma.workflowRun.findMany({
      where: { projectId },
      orderBy: { id: 'desc' },
      take: 20,
    });
    return runs.map(({ stepsJson, ...run }) => ({
      ...run,
      steps: JSON.parse(stepsJson) as StepResult[],
    }));
  }

  async *run(
    userId: number,
    projectId: number,
    key: string,
    input: string,
    signal: AbortSignal,
  ): AsyncGenerator<WorkflowEvent> {
    const project = await this.projects.get(userId, projectId);
    const catalog = await this.catalogService.forUser(userId);
    const workflow = catalog.workflows.get(key);
    const enabled = await this.resources.isEnabled(projectId, catalog);
    if (!workflow || !enabled('workflow', key)) {
      throw new BadRequestException(
        `Il workflow ${key} non è disponibile in questo progetto`,
      );
    }
    // Check every step up front rather than failing halfway through.
    for (const step of workflow.steps) {
      await this.runner.agentFor(userId, projectId, step.agent);
    }

    const run = await this.prisma.workflowRun.create({
      data: { projectId, workflow: key, input, status: 'running' },
    });
    yield { type: 'run', runId: run.id };

    const steps: StepResult[] = [];
    let status: RunStatus = 'done';
    try {
      for (const [index, step] of workflow.steps.entries()) {
        yield { type: 'step', index, agent: step.agent };
        const result: StepResult = {
          agent: step.agent,
          output: '',
          isError: false,
        };
        steps.push(result);
        for await (const event of this.runner.run({
          userId,
          project,
          agent: step.agent,
          prompt: fill(step.prompt, input, steps.at(-2)?.output ?? ''),
          signal,
        })) {
          if (event.type === 'text') result.output += event.text;
          if (event.type === 'error') result.isError = true;
          if (event.type === 'done' && event.isError) result.isError = true;
          yield event;
        }
        await this.prisma.workflowRun.update({
          where: { id: run.id },
          data: { stepsJson: JSON.stringify(steps) },
        });
        if (signal.aborted) {
          status = 'aborted';
          break;
        }
        if (result.isError) {
          status = 'failed';
          break;
        }
      }
    } catch (error) {
      // The stream is already open: report the failure as an event.
      status = 'failed';
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', message };
    } finally {
      await this.prisma.workflowRun.update({
        where: { id: run.id },
        data: { status, stepsJson: JSON.stringify(steps) },
      });
    }
    yield { type: 'finished', status };
  }
}
