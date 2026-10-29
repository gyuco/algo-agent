import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AgentRunnerService } from '../agents/agent-runner.service.js';
import { ProjectResourcesService } from '../agents/project-resources.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import type { RateLimitSnapshot } from '../claude/rate-limit.js';
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
import { BudgetGuard, shouldInterrupt } from './budget-guard.service.js';
import { MissionEventBus } from './mission-event-bus.js';
import { MissionFlowService, type TurnPurpose } from './mission-flow.service.js';
import { MissionTools } from './mission-tools.js';
import { orchestratorAgent } from './missions.service.js';
import { reviewSystemPrompt } from './orchestrator-prompt.js';
import { PlanValidationService } from './plan-validation.js';
import { planSchema } from './plan-schema.js';

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
    private readonly budget: BudgetGuard,
    private readonly bus: MissionEventBus,
    private readonly flow: MissionFlowService,
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
    const purpose =
      run.purposeJson
        ? ((JSON.parse(run.purposeJson) as { purpose?: TurnPurpose }).purpose ??
          'briefing')
        : 'briefing';
    const purposeData = run.purposeJson
      ? (JSON.parse(run.purposeJson) as {
          milestone?: string;
          checksOk?: boolean;
        })
      : {};
    const newProject = mission.newProjectJson
      ? (JSON.parse(mission.newProjectJson) as { briefingDir?: string })
      : null;
    const project =
      mission.projectId !== null
        ? await this.projects.get(run.userId, mission.projectId)
        : { id: null, path: newProject?.briefingDir ?? '' };
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
      purpose,
      ...(purposeData.milestone ? { milestone: purposeData.milestone } : {}),
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
    // §2.4: a session that runs out of the five-hour window ends the turn.
    const parsedPlan = mission.planJson
      ? planSchema.safeParse(JSON.parse(mission.planJson))
      : null;
    const minRemaining = parsedPlan?.success
      ? parsedPlan.data.budget.fiveHourMinRemaining
      : 0.1;
    const cut = new AbortController();
    let interrupted = false;
    const agentSpec =
      purpose === 'briefing'
        ? orchestratorAgent()
        : { ...orchestratorAgent(), prompt: reviewSystemPrompt() };
    const sessionId =
      purpose === 'briefing' || purpose === 'revision'
        ? (run.sessionId ?? mission.sessionId ?? undefined)
        : (run.sessionId ?? undefined);
    for await (const event of this.runner.run({
      userId: run.userId,
      project,
      agentSpec,
      cwd:
        purpose === 'briefing'
          ? mission.projectId === null
            ? (newProject?.briefingDir ?? undefined)
            : undefined
          : (mission.worktreePath ?? undefined),
      briefingMissionId:
        mission.projectId === null ? mission.id : undefined,
      prompt: {
        text: run.input,
        attachments: await this.files.attachments(run.id),
      },
      sessionId,
      model: mission.orchestratorModel,
      appTools,
      toolContext: {
        cwd:
          purpose === 'briefing'
            ? project.path
            : (mission.worktreePath ?? project.path),
        mission: { missionId: mission.id, runId: run.id },
      },
      turnClosed: () => turn.closed || turn.closing,
      signal: AbortSignal.any([signal, cut.signal]),
    })) {
      if (event.type === 'usage' && !interrupted) {
        const snapshot = event.details.rateLimits as
          | RateLimitSnapshot
          | undefined;
        if (shouldInterrupt(snapshot, minRemaining)) {
          interrupted = true;
          cut.abort();
        }
      }
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
    if (interrupted) {
      const entry = await this.prisma.missionEntry
        .create({
          data: {
            missionId: mission.id,
            kind: 'error',
            dataJson: JSON.stringify({
              message: 'Turno interrotto per il budget',
              code: 'budget',
            }),
          },
        })
        .catch(() => null);
      if (entry) this.bus.publish(entry);
    } else if (purpose !== 'briefing') {
      await this.flow
        .afterTurn(mission.id, purpose, outcome, turn, {
          milestone: purposeData.milestone,
          checksOk: purposeData.checksOk,
        })
        .catch(() => undefined);
    }
    return outcome;
  }
}
