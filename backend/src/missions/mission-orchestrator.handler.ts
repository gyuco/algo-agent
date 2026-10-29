import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AgentRunnerService } from '../agents/agent-runner.service.js';
import { ProjectResourcesService } from '../agents/project-resources.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import type { Run } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RunFiles } from '../runs/run-files.js';
import { RunHandlers } from '../runs/run-handlers.js';
import type {
  RunEventData,
  RunHandler,
  RunOutcome,
} from '../runs/run-types.js';
import { MissionTools } from './mission-tools.js';
import { orchestratorAgent } from './missions.service.js';
import { PlanValidationService } from './plan-validation.js';

/** A briefing turn: the mission orchestrator talks, reads and proposes. */
@Injectable()
export class MissionOrchestratorHandler implements RunHandler, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly runner: AgentRunnerService,
    private readonly catalogService: CatalogService,
    private readonly resources: ProjectResourcesService,
    private readonly validation: PlanValidationService,
    private readonly tools: MissionTools,
    private readonly files: RunFiles,
    private readonly handlers: RunHandlers,
  ) {}

  onModuleInit() {
    this.handlers.register('mission-orchestrator', this);
  }

  async *execute(
    run: Run,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, RunOutcome> {
    if (!run.missionId) throw new Error('Il turno non appartiene a una missione');
    const mission = await this.prisma.mission.findUnique({
      where: { id: run.missionId },
    });
    if (!mission) throw new Error('Missione non trovata');
    if (mission.status === 'aborted') return 'done';
    const project = await this.projects.get(run.userId, mission.projectId);
    const catalog = await this.catalogService.forProject(
      run.userId,
      mission.projectId,
    );
    const enabled = await this.resources.isEnabled(mission.projectId, catalog);

    const turn = { closed: false, closing: false };
    const closeTurn = () => {
      turn.closed = true;
    };
    const appTools = this.tools.forRun({
      mission,
      runId: run.id,
      validate: (plan) =>
        this.validation.validate(run.userId, project, plan, catalog, enabled),
      closeTurn,
      beginClose: () => {
        if (turn.closed || turn.closing) return false;
        turn.closing = true;
        return true;
      },
      cancelClose: () => {
        turn.closing = false;
      },
    });

    let outcome: RunOutcome = 'done';
    let costUsd = 0;
    for await (const event of this.runner.run({
      userId: run.userId,
      project,
      agentSpec: orchestratorAgent(),
      prompt: {
        text: run.input,
        attachments: await this.files.attachments(run.id),
      },
      sessionId: run.sessionId ?? mission.sessionId ?? undefined,
      model: mission.orchestratorModel,
      appTools,
      toolContext: {
        cwd: project.path,
        mission: { missionId: mission.id, runId: run.id },
      },
      turnClosed: () => turn.closed || turn.closing,
      signal,
    })) {
      if (event.type === 'session') {
        // The executor persists sessions for chat runs only; missions keep their own.
        await this.prisma.mission.update({
          where: { id: mission.id },
          data: { sessionId: event.sessionId },
        });
        await this.prisma.run.update({
          where: { id: run.id },
          data: { sessionId: event.sessionId, provider: event.provider },
        });
      }
      if (event.type === 'error') outcome = 'failed';
      if (event.type === 'done') {
        costUsd += event.costUsd;
        if (event.isError) outcome = 'failed';
      }
      yield event;
    }
    if (costUsd > 0) {
      await this.prisma.mission
        .update({
          where: { id: mission.id },
          data: { costUsd: { increment: costUsd } },
        })
        .catch(() => undefined);
    }
    return outcome;
  }
}
