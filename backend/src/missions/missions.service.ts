import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { homedir } from 'node:os';
import { AgentRunnerService } from '../agents/agent-runner.service.js';
import { ProjectResourcesService } from '../agents/project-resources.service.js';
import type { AgentSpec } from '../catalog/catalog.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { resolveWorkspace } from '../chat/workspace.js';
import type {
  Mission,
  MissionEntry,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { formatRef, parseRef } from '../providers/model-ref.js';
import type { HistoryMessage } from '../providers/provider.js';
import { ProvidersService } from '../providers/providers.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { channel } from '../runs/run-event-bus.js';
import { RunFiles } from '../runs/run-files.js';
import { RunQueueService } from '../runs/run-queue.service.js';
import { ACTIVE_STATUSES } from '../runs/run-types.js';
import { RunsService } from '../runs/runs.service.js';
import type {
  ApproveMissionDto,
  CreateMissionDto,
  MissionMessageDto,
  MissionsQueryDto,
} from './dto/mission.dto.js';
import { resolveBaseBranch } from './git-read.js';
import { MissionEventBus } from './mission-event-bus.js';
import { briefingMessage, orchestratorSystemPrompt } from './orchestrator-prompt.js';
import { planSchema, type Plan } from './plan-schema.js';
import { PlanValidationService } from './plan-validation.js';

const TITLE_LENGTH = 80;
const TRANSCRIPT_LENGTH = 60_000;

/** The orchestrator isn't a catalog agent: it exists only for missions. */
export function orchestratorAgent(): AgentSpec {
  return {
    key: '_mission',
    description: 'Orchestratore della missione',
    enabledByDefault: true,
    maxTurns: 60,
    permissions: { files: 'read', tools: [], mcp: [], skills: [] },
    prompt: orchestratorSystemPrompt(),
  };
}

/** What the API returns for a mission: the JSON columns parsed. */
export type MissionView = ReturnType<MissionsService['view']>;

@Injectable()
export class MissionsService {
  /** Missions whose next turn is being queued. In memory, like the event bus: one instance. */
  private readonly sending = new Set<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly projects: ProjectsService,
    private readonly catalogService: CatalogService,
    private readonly resources: ProjectResourcesService,
    private readonly validation: PlanValidationService,
    private readonly providers: ProvidersService,
    private readonly runner: AgentRunnerService,
    private readonly queue: RunQueueService,
    private readonly files: RunFiles,
    private readonly runs: RunsService,
    private readonly bus: MissionEventBus,
  ) {}

  private workspaceRoot() {
    return this.config.get<string>('WORKSPACE_ROOT') || homedir();
  }

  view(mission: Mission) {
    const { planJson, waitJson, ...rest } = mission;
    return {
      ...rest,
      plan: planJson ? (JSON.parse(planJson) as Plan) : null,
      wait: waitJson
        ? (JSON.parse(waitJson) as Record<string, unknown>)
        : null,
    };
  }

  entryView(entry: MissionEntry) {
    return {
      id: entry.id,
      missionId: entry.missionId,
      taskId: entry.taskId,
      kind: entry.kind,
      notify: entry.notify,
      data: JSON.parse(entry.dataJson) as unknown,
      createdAt: entry.createdAt,
    };
  }

  private async find(userId: number, id: number) {
    const mission = await this.prisma.mission.findFirst({
      where: { id, userId },
    });
    if (!mission) throw new NotFoundException('Missione non trovata');
    return mission;
  }

  private async entry(
    missionId: number,
    kind: string,
    data: unknown,
    extra: { taskId?: number; notify?: boolean } = {},
  ) {
    const row = await this.prisma.missionEntry.create({
      data: {
        missionId,
        kind,
        dataJson: JSON.stringify(data ?? {}),
        ...extra,
      },
    });
    this.bus.publish(row);
    return row;
  }

  async list(userId: number, query: MissionsQueryDto) {
    const missions = await this.prisma.mission.findMany({
      where: {
        userId,
        ...(query.status && { status: query.status }),
        ...(query.projectId !== undefined && { projectId: query.projectId }),
      },
      orderBy: { id: 'desc' },
      take: 100,
    });
    return missions.map((m) => this.view(m));
  }

  async get(userId: number, id: number) {
    const mission = await this.find(userId, id);
    return this.withValidation(userId, mission);
  }

  private async withValidation(userId: number, mission: Mission) {
    const view = this.view(mission);
    if (!mission.planJson) return { ...view, validationErrors: [], planEstimate: 0 };
    const plan = planSchema.safeParse(JSON.parse(mission.planJson));
    if (!plan.success) {
      return {
        ...view,
        validationErrors: ['Il piano salvato non è più leggibile'],
        planEstimate: 0,
      };
    }
    const project = await this.projects.get(userId, mission.projectId);
    const { catalog, enabled } = await this.context(userId, mission.projectId);
    if (mission.status !== 'planned') {
      return {
        ...view,
        validationErrors: [],
        planEstimate: this.validation.estimate(plan.data, catalog),
      };
    }
    const result = await this.validation.validate(
      userId,
      project,
      plan.data,
      catalog,
      enabled,
    );
    return { ...view, validationErrors: result.errors, planEstimate: result.sessions };
  }

  private async context(userId: number, projectId: number) {
    const catalog = await this.catalogService.forProject(userId, projectId);
    const enabled = await this.resources.isEnabled(projectId, catalog);
    return { catalog, enabled };
  }

  async entries(userId: number, id: number) {
    await this.find(userId, id);
    const rows = await this.prisma.missionEntry.findMany({
      where: { missionId: id },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => this.entryView(r));
  }

  /** The mission's log after `after`, then live entries until the client goes away. */
  async *follow(
    userId: number,
    id: number,
    after: number,
    signal: AbortSignal,
  ): AsyncGenerator<MissionEntry> {
    await this.find(userId, id);
    const live = channel<MissionEntry>(signal);
    live.onClose(this.bus.subscribe(id, (entry) => live.push(entry)));

    const stored = await this.prisma.missionEntry.findMany({
      where: { missionId: id, id: { gt: after } },
      orderBy: { id: 'asc' },
    });
    let last = after;
    for (const row of stored) {
      yield row;
      last = row.id;
    }
    for await (const row of live.values()) {
      if (row.id <= last) continue;
      yield row;
      last = row.id;
    }
  }

  async create(userId: number, projectId: number, dto: CreateMissionDto) {
    const project = await this.projects.get(userId, projectId);
    await this.assertOrchestratorConnected(userId, true);
    const from = dto.fromSession
      ? await this.fromConversation(userId, project, dto.fromSession)
      : null;
    const attachments = [...(dto.attachments ?? []), ...(from?.attachments ?? [])].slice(-5);
    if (!dto.input && !attachments.length && !from) {
      throw new BadRequestException('Scrivi cosa vuoi ottenere');
    }

    const baseBranch = await resolveBaseBranch(project.path);
    const input = dto.input ?? '';
    const title =
      input.trim().slice(0, TITLE_LENGTH) ||
      from?.title ||
      (from ? 'Missione dalla conversazione' : 'Nuova missione');
    const mission = await this.prisma.mission.create({
      data: {
        projectId: project.id,
        userId,
        title,
        status: 'briefing',
        mode: dto.mode,
        input,
        orchestratorModel: dto.orchestratorModel,
        fromSession: dto.fromSession ?? null,
        baseBranch,
      },
    });

    try {
      const { catalog, enabled } = await this.context(userId, project.id);
      const message = briefingMessage({
        request: input,
        baseBranch,
        agents: [...catalog.agents.values()]
          .filter((a) => enabled('agent', a.key))
          .map((a) => `- ${a.key}: ${a.description}`),
        templates: [...catalog.workflows.values()]
          .filter((w) => w.task === true && enabled('workflow', w.key))
          .map((w) => `- ${w.key}: ${w.description}`),
        models: (await this.providers.statuses(userId))
          .filter((s) => s.connected)
          .flatMap((s) => s.models.map((m) => `- ${m.value}`)),
        transcript: from?.transcript,
      });
      const run = await this.enqueue(mission, project, message, attachments);
      if (input || attachments.length) {
        await this.entry(mission.id, 'note', {
          text: input,
          attachments: attachments.map((a) => ({
            name: a.name,
            mediaType: a.mediaType,
          })),
        });
      }
      await this.entry(mission.id, 'turn', { runId: run.id });
      return { ...this.view(mission), runId: run.id };
    } catch (error) {
      // Don't leave a mission without its first turn.
      await this.prisma.mission.delete({ where: { id: mission.id } }).catch(() => undefined);
      throw error;
    }
  }

  private async assertOrchestratorConnected(userId: number, deep = false) {
    if (!deep) {
      const connected = await this.providers.connected(userId);
      if (!connected.some((p) => p.id === 'claude')) {
        throw new BadRequestException(
          'Claude Code non è connesso: collegalo in Connessioni',
        );
      }
      return;
    }
    const status = await this.providers.status(userId, 'claude');
    if (!status.connected) {
      throw new BadRequestException(
        status.error ?? 'Claude Code non è connesso: collegalo in Connessioni',
      );
    }
  }

  private async enqueue(
    mission: Mission,
    project: { id: number; path: string },
    input: string,
    attachments: CreateMissionDto['attachments'] = [],
  ) {
    await this.assertOrchestratorConnected(mission.userId);
    const { provider } = await this.runner.check({
      userId: mission.userId,
      project,
      agentSpec: orchestratorAgent(),
      model: mission.orchestratorModel,
    });
    return this.queue.enqueue(
      {
        projectId: project.id,
        userId: mission.userId,
        kind: 'mission-orchestrator',
        title: mission.title,
        input,
        sessionId: mission.sessionId,
        model: mission.orchestratorModel,
        provider,
        writes: false,
        missionId: mission.id,
      },
      (run) => this.files.saveAttachments(run.id, attachments ?? []),
    );
  }

  private async fromConversation(
    userId: number,
    project: { id: number; path: string },
    ref: string,
  ) {
    const parsed = parseRef(ref, this.providers.ids());
    const provider = this.providers.get(parsed.provider);
    const cwd = await resolveWorkspace(project.path, this.workspaceRoot());
    const history = await provider.history(userId, cwd, parsed.id);
    if (!history) {
      throw new BadRequestException(
        'La conversazione non esiste in questo progetto',
      );
    }
    const ownRef = formatRef(provider.id, parsed.id);
    const chatRun = await this.prisma.run.findFirst({
      where: {
        userId,
        projectId: project.id,
        kind: 'chat',
        sessionId: ownRef,
      },
      orderBy: { id: 'desc' },
    });
    return {
      title: history.find((m) => m.role === 'user')?.text.slice(0, TITLE_LENGTH),
      transcript: this.transcript(history),
      attachments: await this.conversationAttachments(ownRef, chatRun?.id),
    };
  }

  /** The conversation's files: those saved after a finished turn, then a turn still running. */
  private async conversationAttachments(sessionId: string, activeRunId?: number) {
    const stored = await this.files.sessionAttachments(sessionId);
    const live = activeRunId ? await this.files.attachments(activeRunId) : [];
    const seen = new Set<string>();
    return [...stored, ...live]
      .filter((a) => {
        const key = `${a.name}:${a.mediaType}:${a.data.length}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(-5);
  }

  /** The most recent messages that fit, with a note when older ones were left out. */
  private transcript(history: HistoryMessage[]) {
    const lines: string[] = [];
    let size = 0;
    let cut = false;
    for (const message of [...history].reverse()) {
      const line = `${message.role === 'user' ? 'Utente' : 'Assistente'}: ${message.text}`;
      if (size + line.length > TRANSCRIPT_LENGTH) {
        cut = true;
        break;
      }
      lines.unshift(line);
      size += line.length;
    }
    if (cut) lines.unshift('(parte meno recente della conversazione omessa)');
    return lines.join('\n\n');
  }

  /**
   * Queues the user's answer as the next orchestrator turn. One turn at a
   * time: the check and the enqueue happen under the mission's lock, so two
   * tabs can't start two turns on the same session.
   */
  async messages(userId: number, id: number, dto: MissionMessageDto) {
    const mission = await this.find(userId, id);
    if (mission.status !== 'briefing' && mission.status !== 'planned') {
      throw new ConflictException(
        'La missione non è in briefing: non accetta messaggi',
      );
    }
    if (this.sending.has(id)) {
      throw new ConflictException('Il briefing ha già una risposta in corso');
    }
    this.sending.add(id);
    try {
      if (await this.activeTurn(id)) {
        throw new ConflictException('Il briefing ha già una risposta in corso');
      }
      // Conditional on the status read above: an approval in the meantime wins.
      const { count } = await this.prisma.mission.updateMany({
        where: { id, status: mission.status },
        data: { status: 'briefing', waitJson: null },
      });
      if (!count) {
        throw new ConflictException(
          'La missione è cambiata nel frattempo: ricarica e riprova',
        );
      }
      if (mission.status === 'planned') {
        await this.entry(id, 'status', { status: 'briefing' });
      }
      const project = await this.projects.get(userId, mission.projectId);
      const run = await this.enqueue(
        { ...mission, status: 'briefing' },
        project,
        dto.text ?? '',
        dto.attachments,
      );
      await this.entry(id, 'note', {
        text: dto.text ?? '',
        attachments: (dto.attachments ?? []).map((a) => ({
          name: a.name,
          mediaType: a.mediaType,
        })),
      });
      await this.entry(id, 'turn', { runId: run.id });
      return { runId: run.id };
    } finally {
      this.sending.delete(id);
    }
  }

  private activeTurn(missionId: number) {
    return this.prisma.run.findFirst({
      where: {
        missionId,
        kind: 'mission-orchestrator',
        status: { in: ACTIVE_STATUSES },
      },
      orderBy: { id: 'desc' },
    });
  }

  async approve(userId: number, id: number, dto: ApproveMissionDto) {
    const mission = await this.find(userId, id);
    if (mission.status !== 'planned') {
      throw new ConflictException('La missione non aspetta un\'approvazione');
    }
    if (mission.planVersion !== dto.planVersion) {
      throw new ConflictException(
        'Il piano è cambiato: ricarica e riprova',
      );
    }
    const plan = mission.planJson ? planSchema.safeParse(JSON.parse(mission.planJson)) : null;
    if (!plan?.success) {
      throw new ConflictException('Il piano non è più leggibile: chiedine uno nuovo');
    }
    const project = await this.projects.get(userId, mission.projectId);
    const { catalog, enabled } = await this.context(userId, mission.projectId);
    const result = await this.validation.validate(
      userId,
      project,
      plan.data,
      catalog,
      enabled,
    );
    if (result.errors.length) {
      throw new ConflictException({
        message: 'Il piano non è più valido: ricaricalo o commentalo',
        errors: result.errors,
      });
    }
    const { count } = await this.prisma.mission.updateMany({
      where: {
        id,
        userId,
        status: 'planned',
        planVersion: dto.planVersion,
      },
      data: {
        status: 'approved',
        mode: dto.mode,
        approvedVersion: dto.planVersion,
        approvedAt: new Date(),
        waitJson: null,
        budgetJson: JSON.stringify(plan.data.budget),
        baseBranch: mission.baseBranch
          ? (plan.data.baseBranch ?? mission.baseBranch)
          : null,
      },
    });
    if (!count) throw new ConflictException('Il piano è cambiato: ricarica e riprova');
    await this.entry(id, 'status', {
      status: 'approved',
      version: dto.planVersion,
      mode: dto.mode,
    });
    return this.get(userId, id);
  }

  async revise(userId: number, id: number) {
    await this.find(userId, id);
    const { count } = await this.prisma.mission.updateMany({
      where: { id, userId, status: 'approved' },
      data: { status: 'briefing', waitJson: null, approvedAt: null },
    });
    if (!count) {
      throw new ConflictException('Solo una missione approvata si può rivedere');
    }
    await this.entry(id, 'status', { status: 'briefing' });
    return this.get(userId, id);
  }

  async abort(userId: number, id: number) {
    await this.find(userId, id);
    const active = await this.prisma.run.findMany({
      where: { missionId: id, status: { in: ACTIVE_STATUSES } },
      select: { id: true },
    });
    for (const run of active) await this.runs.abort(userId, run.id);
    const { count } = await this.prisma.mission.updateMany({
      where: { id, userId, status: { not: 'aborted' } },
      data: { status: 'aborted', waitJson: null, finishedAt: new Date() },
    });
    if (count) await this.entry(id, 'status', { status: 'aborted' });
    return this.get(userId, id);
  }

  async remove(userId: number, id: number) {
    const mission = await this.find(userId, id);
    if (mission.status !== 'aborted' && mission.status !== 'approved') {
      throw new ConflictException(
        'Si cancella solo una missione approvata o fermata',
      );
    }
    const runs = await this.prisma.run.findMany({
      where: { missionId: id },
      select: { id: true, status: true },
    });
    for (const run of runs) {
      if ((ACTIVE_STATUSES as string[]).includes(run.status)) {
        await this.runs.abort(userId, run.id);
      }
      await this.files.remove(run.id);
    }
    await this.prisma.mission.delete({ where: { id } });
  }

}
