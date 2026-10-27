import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';

@Module({
  imports: [AgentsModule, ProjectsModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
})
export class WorkflowsModule {}
