import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { RunsModule } from '../runs/runs.module.js';
import { AgentRunnerService } from './agent-runner.service.js';
import { AgentsController } from './agents.controller.js';
import { ProjectResourcesService } from './project-resources.service.js';

@Module({
  imports: [ConnectionsModule, ProvidersModule, ProjectsModule, RunsModule],
  controllers: [AgentsController],
  providers: [AgentRunnerService, ProjectResourcesService],
  exports: [AgentRunnerService, ProjectResourcesService],
})
export class AgentsModule {}
