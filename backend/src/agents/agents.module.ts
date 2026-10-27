import { Module } from '@nestjs/common';
import { ClaudeModule } from '../claude/claude.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { AgentRunnerService } from './agent-runner.service.js';
import { AgentsController } from './agents.controller.js';
import { ProjectResourcesService } from './project-resources.service.js';

@Module({
  imports: [ClaudeModule, ProjectsModule],
  controllers: [AgentsController],
  providers: [AgentRunnerService, ProjectResourcesService],
  exports: [AgentRunnerService, ProjectResourcesService],
})
export class AgentsModule {}
