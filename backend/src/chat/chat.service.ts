import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { homedir } from 'node:os';
import { AgentRunnerService } from '../agents/agent-runner.service.js';
import type { Run } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { formatRef, parseRef } from '../providers/model-ref.js';
import { ProvidersService } from '../providers/providers.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RunFiles } from '../runs/run-files.js';
import { RunHandlers } from '../runs/run-handlers.js';
import { RunQueueService } from '../runs/run-queue.service.js';
import {
  ACTIVE_STATUSES,
  isActive,
  type RunEventData,
  type RunHandler,
  type RunOutcome,
} from '../runs/run-types.js';
import { ChatMessageDto } from './dto/chat.dto.js';
import { describeWorkspace, resolveWorkspace } from './workspace.js';

/** Lists show this much of a turn's message. */
const TITLE_LENGTH = 80;

/** Where a conversation's latest turn stands, for the list of conversations. */
function turnState(run: Run | undefined, reason: (id: number) => unknown) {
  return {
    activeRun:
      run && isActive(run.status)
        ? { runId: run.id, status: run.status, reason: reason(run.id) }
        : null,
    unread: Boolean(
      run?.finishedAt && (!run.seenAt || run.seenAt < run.finishedAt),
    ),
  };
}

/** Chat turns: each message is a run of its own, queued and executed in the background. */
@Injectable()
export class ChatService implements RunHandler, OnModuleInit {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly runner: AgentRunnerService,
    private readonly projects: ProjectsService,
    private readonly providers: ProvidersService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly handlers: RunHandlers,
    private readonly queue: RunQueueService,
    private readonly files: RunFiles,
  ) {}

  onModuleInit() {
    this.handlers.register('chat', this);
  }

  workspaceRoot() {
    return this.config.get<string>('WORKSPACE_ROOT') || homedir();
  }

  async workspace(path: string) {
    return describeWorkspace(
      await resolveWorkspace(path, this.workspaceRoot()),
    );
  }

  /**
   * Queues one user turn, with the chosen agent or straight with the model.
   * A conversation takes one turn at a time: 409 while one is queued or running.
   */
  async send(userId: number, dto: ChatMessageDto) {
    const project = await this.projects.get(userId, dto.projectId);
    if (dto.sessionId && (await this.activeTurn(userId, dto.sessionId))) {
      throw new ConflictException(
        'Questa conversazione ha già una risposta in corso',
      );
    }
    const { provider, writes } = await this.runner.check({
      userId,
      project,
      agent: dto.agent,
      sessionId: dto.sessionId,
      model: dto.model,
    });
    const attachments = dto.attachments ?? [];
    const run = await this.queue.enqueue(
      {
        projectId: project.id,
        userId,
        kind: 'chat',
        title: (dto.message || attachments[0]?.name || '').slice(
          0,
          TITLE_LENGTH,
        ),
        input: dto.message,
        sessionId: dto.sessionId ?? null,
        agent: dto.agent ?? null,
        model: dto.model ?? null,
        effort: dto.effort ?? null,
        provider,
        writes,
      },
      (run) => this.files.saveAttachments(run.id, attachments),
    );
    return { runId: run.id, status: run.status };
  }

  private activeTurn(userId: number, sessionId: string) {
    return this.prisma.run.findFirst({
      where: {
        userId,
        kind: 'chat',
        sessionId,
        status: { in: ACTIVE_STATUSES },
      },
      orderBy: { id: 'desc' },
    });
  }

  /** Runs the turn; it fails when the provider reports an error. */
  async *execute(
    run: Run,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, RunOutcome> {
    const project = await this.projects.get(run.userId, run.projectId);
    let outcome: RunOutcome = 'done';
    for await (const event of this.runner.run({
      userId: run.userId,
      project,
      agent: run.agent ?? undefined,
      prompt: {
        text: run.input,
        attachments: await this.files.attachments(run.id),
      },
      sessionId: run.sessionId ?? undefined,
      model: run.model ?? undefined,
      effort: run.effort ?? undefined,
      signal,
    })) {
      if (event.type === 'error') outcome = 'failed';
      if (event.type === 'done' && event.isError) outcome = 'failed';
      yield event;
    }
    return outcome;
  }

  private async projectFolder(userId: number, projectId: number) {
    const project = await this.projects.get(userId, projectId);
    return resolveWorkspace(project.path, this.workspaceRoot());
  }

  /**
   * The project's conversations on every provider the user connected, newest
   * first, each with its turn in progress and whether its last answer is
   * unread. A provider that can't list them is left out rather than failing
   * the rest. New conversations still waiting for their id come first.
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

    const runs = await this.prisma.run.findMany({
      where: { userId, projectId, kind: 'chat' },
      orderBy: { id: 'desc' },
      take: 200,
    });
    // The orchestrator works in the project folder too: its sessions aren't chats.
    const missions = await this.prisma.mission.findMany({
      where: {
        userId,
        projectId,
        OR: [{ sessionId: { not: null } }, { fromSession: { not: null } }],
      },
      select: { id: true, sessionId: true, fromSession: true },
    });
    const missionSessions = new Set(
      missions.map((m) => m.sessionId).filter((s): s is string => s !== null),
    );
    const missionOfSession = new Map(
      missions
        .filter((m) => m.fromSession)
        .map((m) => [m.fromSession!, m.id] as const),
    );
    const latest = new Map<string, Run>();
    const unnamed: Run[] = [];
    for (const run of runs) {
      if (!run.sessionId) {
        if (isActive(run.status)) unnamed.push(run);
      } else if (!latest.has(run.sessionId)) {
        latest.set(run.sessionId, run);
      }
    }
    const reason = (id: number) => this.queue.reason(id);
    const listed = lists
      .flat()
      .filter((s) => !missionSessions.has(s.sessionId))
      .map((s) => ({
        ...s,
        runId: null as number | null,
        missionId: missionOfSession.get(s.sessionId) ?? null,
        ...turnState(latest.get(s.sessionId), reason),
      }));
    const known = new Set(listed.map((s) => s.sessionId));
    // A conversation whose first turn is still running may not be saved by the provider yet.
    const pending = [...latest.values()]
      .filter((r) => isActive(r.status) && !known.has(r.sessionId!))
      .map((r) => this.fromRun(r, r.sessionId, reason));
    const sorted = [...listed, ...pending].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    return [...unnamed.map((r) => this.fromRun(r, null, reason)), ...sorted];
  }

  private fromRun(
    run: Run,
    sessionId: string | null,
    reason: (id: number) => unknown,
  ) {
    return {
      sessionId,
      provider: run.provider ?? '',
      title: run.title,
      updatedAt: run.createdAt.toISOString(),
      runId: run.id,
      missionId: null as number | null,
      ...turnState(run, reason),
    };
  }

  /**
   * A past conversation of the project, with its id to continue it. With a
   * turn in progress, its messages stop before that turn: the client shows it
   * from the run's events instead, so it doesn't appear twice.
   */
  async history(userId: number, projectId: number, sessionId: string) {
    const cwd = await this.projectFolder(userId, projectId);
    const ref = parseRef(sessionId, this.providers.ids());
    const provider = this.providers.get(ref.provider);
    const ownRef = formatRef(provider.id, ref.id);
    const latest = await this.prisma.run.findFirst({
      where: { userId, projectId, kind: 'chat', sessionId: ownRef },
      orderBy: { id: 'desc' },
    });
    const active = latest && isActive(latest.status) ? latest : null;
    let messages = await provider.history(userId, cwd, ref.id);
    if (!messages && !active) {
      throw new NotFoundException('Conversazione non trovata');
    }
    messages ??= [];
    if (active) {
      const turn = messages.findLastIndex((m) => m.role === 'user');
      if (turn >= 0 && messages[turn].text.trim() === active.input.trim()) {
        messages = messages.slice(0, turn);
      }
    }
    const mission = await this.prisma.mission.findFirst({
      where: { userId, projectId, fromSession: ownRef },
      select: { id: true },
      orderBy: { id: 'desc' },
    });
    return {
      sessionId: ownRef,
      provider: provider.id,
      messages,
      missionId: mission?.id ?? null,
      /** Model chosen for the latest turn, to offer it again; null: the default one. */
      model: latest?.model ?? null,
      /** Effort chosen for the latest turn; null: the model's default. */
      effort: latest?.effort ?? null,
      /** The conversation's latest turn, to follow it or mark it seen. */
      lastRun: latest
        ? { runId: latest.id, status: latest.status, input: latest.input }
        : null,
    };
  }
}
