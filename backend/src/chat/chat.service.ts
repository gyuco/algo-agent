import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { homedir } from 'node:os';
import { AgentRunnerService } from '../agents/agent-runner.service.js';
import type { ChatEvent } from '../providers/provider.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ChatMessageDto } from './dto/chat.dto.js';
import { describeWorkspace, resolveWorkspace } from './workspace.js';

@Injectable()
export class ChatService {
  constructor(
    private readonly runner: AgentRunnerService,
    private readonly projects: ProjectsService,
    private readonly config: ConfigService,
  ) {}

  workspaceRoot() {
    return this.config.get<string>('WORKSPACE_ROOT') || homedir();
  }

  async workspace(path: string) {
    return describeWorkspace(
      await resolveWorkspace(path, this.workspaceRoot()),
    );
  }

  /** Runs one user turn, with the chosen agent or straight with the model, and yields its chat events. */
  async *send(
    userId: number,
    dto: ChatMessageDto,
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const project = await this.projects.get(userId, dto.projectId);
    yield* this.runner.run({
      userId,
      project,
      agent: dto.agent,
      prompt: { text: dto.message, attachments: dto.attachments ?? [] },
      sessionId: dto.sessionId,
      model: dto.model,
      signal,
    });
  }
}
