import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { RunsModule } from '../runs/runs.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

@Module({
  imports: [AgentsModule, ProjectsModule, ProvidersModule, RunsModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
