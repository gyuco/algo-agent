import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { homedir } from 'node:os';
import { AgentRunnerService } from '../agents/agent-runner.service.js';
import { formatRef, parseRef } from '../providers/model-ref.js';
import type { ChatEvent } from '../providers/provider.js';
import { ProvidersService } from '../providers/providers.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ChatMessageDto } from './dto/chat.dto.js';
import { describeWorkspace, resolveWorkspace } from './workspace.js';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly runner: AgentRunnerService,
    private readonly projects: ProjectsService,
    private readonly providers: ProvidersService,
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

  private async projectFolder(userId: number, projectId: number) {
    const project = await this.projects.get(userId, projectId);
    return resolveWorkspace(project.path, this.workspaceRoot());
  }

  /**
   * The project's conversations on every provider the user connected, newest
   * first. A provider that can't list them is left out rather than failing the rest.
   */
  async sessions(userId: number, projectId: number) {
    const cwd = await this.projectFolder(userId, projectId);
    const lists = await Promise.all(
      (await this.providers.connected(userId)).map(async (provider) => {
        try {
          const sessions = await provider.sessions(userId, cwd);
          return sessions.map((s) => ({
            sessionId: formatRef(provider.id, s.id),
            provider: provider.id,
            title: s.title,
            updatedAt: s.updatedAt,
          }));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(`${provider.id} sessions failed: ${message}`);
          return [];
        }
      }),
    );
    return lists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** A past conversation of the project, with its id to continue it. */
  async history(userId: number, projectId: number, sessionId: string) {
    const cwd = await this.projectFolder(userId, projectId);
    const ref = parseRef(sessionId, this.providers.ids());
    const provider = this.providers.get(ref.provider);
    const messages = await provider.history(userId, cwd, ref.id);
    if (!messages) throw new NotFoundException('Conversazione non trovata');
    return {
      sessionId: formatRef(provider.id, ref.id),
      provider: provider.id,
      messages,
    };
  }
}
