import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { RunsModule } from '../runs/runs.module.js';
import { VaultModule } from '../vault/vault.module.js';
import { ChecksService } from './checks.service.js';
import { GitService } from './git-service.js';
import { MissionEventBus } from './mission-event-bus.js';
import { MissionOrchestratorHandler } from './mission-orchestrator.handler.js';
import { MissionPrepareHandler } from './mission-prepare.handler.js';
import { MissionScheduler } from './mission-scheduler.service.js';
import { MissionTaskHandler } from './mission-task.handler.js';
import { MissionTasksService } from './mission-tasks.service.js';
import { MissionTools } from './mission-tools.js';
import {
  MissionsController,
  ProjectMissionsController,
} from './missions.controller.js';
import { MissionsService } from './missions.service.js';
import { PlanValidationService } from './plan-validation.js';
import { MacSandbox, Sandbox } from './sandbox.js';
import { SystemController } from './sandbox.controller.js';
import { ScopeService } from './scope.service.js';
import { TaskGraphFactory } from './task-graph.factory.js';

/** Missions: briefing, plan validation, approval, tasks and the mission log. */
@Module({
  imports: [
    AgentsModule,
    ProjectsModule,
    ProvidersModule,
    RunsModule,
    VaultModule,
  ],
  controllers: [
    ProjectMissionsController,
    MissionsController,
    SystemController,
  ],
  providers: [
    MissionEventBus,
    MissionTools,
    PlanValidationService,
    MissionOrchestratorHandler,
    MissionPrepareHandler,
    MissionTaskHandler,
    MissionScheduler,
    MissionTasksService,
    TaskGraphFactory,
    MissionsService,
    GitService,
    ChecksService,
    ScopeService,
    { provide: Sandbox, useClass: MacSandbox },
  ],
  exports: [MissionsService, GitService],
})
export class MissionsModule {}
