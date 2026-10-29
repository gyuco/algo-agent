import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { RunsModule } from '../runs/runs.module.js';
import { MissionEventBus } from './mission-event-bus.js';
import { MissionOrchestratorHandler } from './mission-orchestrator.handler.js';
import { MissionTools } from './mission-tools.js';
import { MissionsController, ProjectMissionsController } from './missions.controller.js';
import { MissionsService } from './missions.service.js';
import { PlanValidationService } from './plan-validation.js';

/** Missions: briefing, plan validation, approval and the mission log. */
@Module({
  imports: [AgentsModule, ProjectsModule, ProvidersModule, RunsModule],
  controllers: [ProjectMissionsController, MissionsController],
  providers: [
    MissionEventBus,
    MissionTools,
    PlanValidationService,
    MissionOrchestratorHandler,
    MissionsService,
  ],
  exports: [MissionsService],
})
export class MissionsModule {}
