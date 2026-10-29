import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AgentRunnerService } from '../agents/agent-runner.service.js';
import { ProjectResourcesService } from '../agents/project-resources.service.js';
import type { AgentSpec } from '../catalog/catalog.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { resolveWorkspace } from '../chat/workspace.js';
import type { Mission, MissionEntry } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { formatRef, parseRef } from '../providers/model-ref.js';
import type { HistoryMessage } from '../providers/provider.js';
import { ProvidersService } from '../providers/providers.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { channel } from '../runs/run-event-bus.js';
import { RunFiles } from '../runs/run-files.js';
import { RunConfig } from '../runs/run-config.js';
import { RunQueueService } from '../runs/run-queue.service.js';
import { ACTIVE_STATUSES } from '../runs/run-types.js';
import { RunsService } from '../runs/runs.service.js';
import { RunExecutorService } from '../runs/run-executor.service.js';
import type {
  ApproveMissionDto,
  CreateMissionDto,
  MissionMessageDto,
  MissionsQueryDto,
  NewProjectMissionDto,
} from './dto/mission.dto.js';
import { GitService } from './git-service.js';
import {
  BudgetGuard,
  initialBudget,
  readBudget,
  rethresholdBudget,
  type BudgetThresholds,
} from './budget-guard.service.js';
import { MissionEventBus } from './mission-event-bus.js';
import {
  currentMilestone,
  readProgress,
} from './mission-progress.js';
import {
  missionBranchName,
  missionWorktreePath,
  setupMarker,
  taskBranchName,
  taskWorktreePath,
} from './mission-paths.js';
import { taskView } from './mission-task.handler.js';
import {
  briefingMessage,
  orchestratorSystemPrompt,
  revisionMessage,
} from './orchestrator-prompt.js';
import { planSchema, type Plan } from './plan-schema.js';
import { PlanValidationService } from './plan-validation.js';
import { Sandbox } from './sandbox.js';

const TITLE_LENGTH = 80;
const TRANSCRIPT_LENGTH = 60_000;
const RECONCILE_MS = 30_000;
/** The states a stopped mission can go back to. */
const RESUMABLE = [
  'briefing',
  'planned',
  'approved',
  'running',
  'waiting',
  'paused',
  'integrating',
];

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
export class MissionsService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  /** Missions whose next turn is being queued. In memory, like the event bus: one instance. */
  private readonly sending = new Set<number>();
  /** Missions whose preparation is being queued: approve and reconciliation can meet here. */
  private readonly preparing = new Set<number>();
  /** missionId → userId, for the user's notification stream. */
  private readonly owners = new Map<number, number>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileStart: ReturnType<typeof setTimeout> | null = null;

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
    private readonly git: GitService,
    private readonly sandbox: Sandbox,
    private readonly runConfig: RunConfig,
    private readonly budget: BudgetGuard,
    private readonly executor: RunExecutorService,
  ) {}

  onApplicationBootstrap() {
    this.reconcileTimer = setInterval(
      () => void this.reconcile(),
      RECONCILE_MS,
    );
    this.reconcileTimer.unref();
    // Let recovery close what the previous process left running first.
    this.reconcileStart = setTimeout(() => void this.reconcile(), 1_000);
    this.reconcileStart.unref();
  }

  onApplicationShutdown() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.reconcileStart) clearTimeout(this.reconcileStart);
  }

  /**
   * Re-queues the preparation of every approved mission without an active
   * `mission-prepare`: a restart or a lost process left it there.
   */
  async reconcile() {
    const missions = await this.prisma.mission.findMany({
      where: { status: 'approved' },
      select: { id: true },
    });
    for (const mission of missions) {
      await this.queuePrepare(mission.id).catch(() => undefined);
    }
    // §5.2: a checks run cut by a restart goes back to the queue; so does a
    // publication, which reuses an open pull request.
    const orphaned = await this.prisma.run.findMany({
      where: {
        kind: { in: ['mission-checks', 'mission-integrate', 'mission-publish'] },
        status: 'interrupted',
        missionId: { not: null },
      },
      select: { id: true },
    });
    for (const run of orphaned) {
      await this.prisma.run
        .updateMany({
          where: { id: run.id, status: 'interrupted' },
          data: { status: 'queued', error: null },
        })
        .catch(() => undefined);
    }
    if (orphaned.length) this.queue.wake();
  }

  private workspaceRoot() {
    return this.config.get<string>('WORKSPACE_ROOT') || homedir();
  }

  view(mission: Mission) {
    const { planJson, waitJson, ...rest } = mission;
    return {
      ...rest,
      plan: planJson ? (JSON.parse(planJson) as Plan) : null,
      wait: waitJson ? (JSON.parse(waitJson) as Record<string, unknown>) : null,
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
    if (!this.owners.has(missionId)) {
      const mission = await this.prisma.mission.findUnique({
        where: { id: missionId },
        select: { userId: true },
      });
      if (mission) {
        this.owners.set(missionId, mission.userId);
        this.bus.remember(missionId, mission.userId);
      }
    }
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
    if (!query.unread) return missions.map((m) => this.view(m));
    const unread = [];
    for (const mission of missions) {
      if (await this.unread(mission.id, mission.seenAt)) {
        unread.push(this.view(mission));
      }
    }
    return unread;
  }

  async get(userId: number, id: number) {
    const mission = await this.find(userId, id);
    const view = await this.withValidation(userId, mission);
    const preparation = await this.activePrepare(id);
    const rows = view.plan
      ? await this.prisma.missionTask.findMany({ where: { missionId: id } })
      : [];
    const saved = readProgress(mission);
    const current = view.plan
      ? currentMilestone(view.plan, rows, saved)
      : null;
    const mergeQueue = rows
      .filter((row) => row.status === 'ready')
      .sort(
        (a, b) =>
          (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0) ||
          a.id - b.id,
      )
      .map((row) => row.id);
    return {
      ...view,
      preparation: preparation ? { runId: preparation.id } : null,
      tasks: view.plan ? await this.taskViews(id, view.plan) : [],
      budget: await this.budget.view(id),
      progress: {
        reviewedMilestones: saved.reviewedMilestones,
        currentMilestone: current,
        mergeQueue,
      },
    };
  }

  private async taskViews(missionId: number, plan: Plan) {
    const rows = await this.prisma.missionTask.findMany({
      where: { missionId },
    });
    const byKey = new Map(rows.map((t) => [t.key, t]));
    const tasks = [];
    for (const milestone of plan.milestones) {
      for (const planned of milestone.tasks) {
        const row = byKey.get(planned.key);
        if (!row) continue;
        const waitingOn = planned.needs.filter((need) => {
          const status = byKey.get(need)?.status;
          return status !== 'done' && status !== 'skipped';
        });
        tasks.push({
          ...taskView(row, plan, waitingOn),
          milestone: milestone.id,
          title: planned.title ?? planned.key,
        });
      }
    }
    return tasks;
  }

  private async withValidation(userId: number, mission: Mission) {
    const view = this.view(mission);
    if (!mission.planJson)
      return { ...view, validationErrors: [], planEstimate: 0 };
    const plan = planSchema.safeParse(JSON.parse(mission.planJson));
    if (!plan.success) {
      return {
        ...view,
        validationErrors: ['Il piano salvato non è più leggibile'],
        planEstimate: 0,
      };
    }
    const project =
      mission.projectId === null
        ? { id: null, path: this.briefingDir(mission) }
        : await this.projects.get(userId, mission.projectId);
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
    return {
      ...view,
      validationErrors: result.errors,
      planEstimate: result.sessions,
    };
  }

  private async context(userId: number, projectId: number | null) {
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

  /** Every entry of the user's missions after `after`, then live ones (§7.1). */
  async *followUser(
    userId: number,
    after: number,
    signal: AbortSignal,
  ): AsyncGenerator<MissionEntry> {
    const missions = await this.prisma.mission.findMany({
      where: { userId },
      select: { id: true },
    });
    for (const mission of missions) {
      this.owners.set(mission.id, userId);
      this.bus.remember(mission.id, userId);
    }
    const live = channel<MissionEntry>(signal);
    live.onClose(this.bus.subscribeUser(userId, (entry) => live.push(entry)));

    const stored = await this.prisma.missionEntry.findMany({
      where: { id: { gt: after }, mission: { userId } },
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

  /** Whether the mission has a notification newer than its last opening. */
  private async unread(missionId: number, seenAt: Date | null) {
    const last = await this.prisma.missionEntry.findFirst({
      where: { missionId, notify: true },
      orderBy: { id: 'desc' },
      select: { createdAt: true },
    });
    return Boolean(last && (!seenAt || last.createdAt > seenAt));
  }

  /** §8.2: a mission that starts on an empty folder and creates its project at approval. */
  async createNewProject(userId: number, dto: NewProjectMissionDto) {
    await this.assertOrchestratorConnected(userId, true);
    if (!/^[a-z0-9][a-z0-9-_.]{0,99}$/.test(dto.name)) {
      throw new BadRequestException(
        'Il nome del progetto usa minuscole, cifre, trattini, punti e _',
      );
    }
    const folder = join(this.workspaceRoot(), dto.name);
    if (existsSync(folder)) {
      throw new ConflictException(
        `La cartella ${folder} esiste già: scegli un altro nome`,
      );
    }
    const input = dto.input ?? '';
    const title = input.trim().slice(0, TITLE_LENGTH) || dto.name;
    const mission = await this.prisma.mission.create({
      data: {
        projectId: null,
        userId,
        title,
        status: 'briefing',
        mode: dto.mode,
        input,
        orchestratorModel: dto.orchestratorModel,
        baseBranch: 'main',
        newProjectJson: JSON.stringify({
          name: dto.name,
          forge: dto.forge,
          namespace: dto.namespace ?? null,
          visibility: dto.visibility,
          briefingDir: '',
        }),
      },
    });
    const briefingDir = join(
      await this.runConfig.resolvedDataDir(),
      'briefing',
      String(mission.id),
    );
    await mkdir(briefingDir, { recursive: true, mode: 0o700 });
    await this.prisma.mission.update({
      where: { id: mission.id },
      data: {
        newProjectJson: JSON.stringify({
          name: dto.name,
          forge: dto.forge,
          namespace: dto.namespace ?? null,
          visibility: dto.visibility,
          briefingDir,
        }),
      },
    });
    try {
      const { catalog, enabled } = await this.context(userId, null);
      const message = briefingMessage({
        request: input,
        baseBranch: 'main',
        newProject: { name: dto.name, forge: dto.forge },
        agents: [...catalog.agents.values()]
          .filter((a) => enabled('agent', a.key))
          .map((a) => `- ${a.key}: ${a.description}`),
        templates: [...catalog.workflows.values()]
          .filter((w) => w.task === true && enabled('workflow', w.key))
          .map((w) => `- ${w.key}: ${w.description}`),
        models: (await this.providers.statuses(userId))
          .filter((s) => s.connected)
          .flatMap((s) => s.models.map((m) => `- ${m.value}`)),
      });
      const run = await this.enqueue(
        mission,
        { id: null, path: briefingDir },
        message,
        dto.attachments,
      );
      if (input || dto.attachments?.length) {
        await this.entry(mission.id, 'note', {
          text: input,
          attachments: (dto.attachments ?? []).map((a) => ({
            name: a.name,
            mediaType: a.mediaType,
          })),
        });
      }
      await this.entry(mission.id, 'turn', { runId: run.id });
      return { ...this.view(mission), runId: run.id };
    } catch (error) {
      await this.prisma.mission
        .delete({ where: { id: mission.id } })
        .catch(() => undefined);
      await rm(briefingDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  /** The briefing folder of a new project, as the mission saved it. */
  private briefingDir(mission: Mission) {
    if (!mission.newProjectJson) return '';
    try {
      return (
        (JSON.parse(mission.newProjectJson) as { briefingDir?: string })
          .briefingDir ?? ''
      );
    } catch {
      return '';
    }
  }

  /** `POST /missions/:id/seen`: the mission and its notifications are read. */
  async seen(userId: number, id: number) {
    await this.find(userId, id);
    const { count } = await this.prisma.mission.updateMany({
      where: { id, userId },
      data: { seenAt: new Date() },
    });
    if (!count) throw new NotFoundException('Missione non trovata');
    return { seenAt: new Date() };
  }

  /** §7.1: the missions of Richiedono te and In corso, with what each task is doing. */
  async activity(userId: number) {
    const missions = await this.prisma.mission.findMany({
      where: {
        userId,
        status: { in: ['waiting', 'running', 'paused', 'integrating'] },
      },
      orderBy: { updatedAt: 'desc' },
    });
    const projects = await this.prisma.project.findMany({
      where: { userId },
      select: { id: true, name: true },
    });
    const names = new Map(projects.map((project) => [project.id, project.name]));
    const cards = [];
    for (const mission of missions) {
      const plan = mission.planJson
        ? planSchema.safeParse(JSON.parse(mission.planJson))
        : null;
      const rows = plan?.success
        ? await this.prisma.missionTask.findMany({
            where: { missionId: mission.id },
          })
        : [];
      const progress = readProgress(mission);
      const current = plan?.success
        ? currentMilestone(plan.data, rows, progress)
        : null;
      const activeTasks = rows
        .filter((row) =>
          ['running', 'review', 'ready', 'merging', 'scope'].includes(row.status),
        )
        .map((row) => {
          const activity = row.runId
            ? this.executor.activity(row.runId)
            : null;
          const report = row.reportJson
            ? (JSON.parse(row.reportJson) as { summary?: string })
            : null;
          return {
            key: row.key,
            ...(activity?.step ? { step: activity.step.id } : {}),
            ...(activity?.last
              ? { last: activity.last }
              : report?.summary
                ? { last: report.summary.split('\n')[0] }
                : {}),
          };
        });
      const total = plan?.success
        ? plan.data.milestones.find((m) => m.id === current?.id)?.tasks.length ?? 0
        : 0;
      const done = plan?.success
        ? rows.filter(
            (row) =>
              row.milestone === current?.id &&
              (row.status === 'done' || row.status === 'skipped'),
          ).length
        : 0;
      cards.push({
        id: mission.id,
        title: mission.title,
        projectId: mission.projectId,
        projectName: mission.projectId === null ? '' : (names.get(mission.projectId) ?? ''),
        status: mission.status,
        mode: mission.mode,
        wait: mission.waitJson
          ? (JSON.parse(mission.waitJson) as Record<string, unknown>)
          : null,
        milestone: current
          ? { id: current.id, title: current.title, done, total }
          : null,
        activeTasks,
        budget: await this.budget.view(mission.id),
        unread: await this.unread(mission.id, mission.seenAt),
      });
    }
    return {
      waiting: cards.filter((card) => card.status === 'waiting'),
      running: cards.filter((card) => card.status !== 'waiting'),
      unread: cards.filter((card) => card.unread).length,
    };
  }

  async create(userId: number, projectId: number, dto: CreateMissionDto) {
    const project = await this.projects.get(userId, projectId);
    await this.assertOrchestratorConnected(userId, true);
    const from = dto.fromSession
      ? await this.fromConversation(userId, project, dto.fromSession)
      : null;
    const attachments = [
      ...(dto.attachments ?? []),
      ...(from?.attachments ?? []),
    ].slice(-5);
    if (!dto.input && !attachments.length && !from) {
      throw new BadRequestException('Scrivi cosa vuoi ottenere');
    }

    const baseBranch = await this.git.resolveBaseBranch(project.path);
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
      await this.prisma.mission
        .delete({ where: { id: mission.id } })
        .catch(() => undefined);
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
    project: { id: number | null; path: string },
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
      title: history
        .find((m) => m.role === 'user')
        ?.text.slice(0, TITLE_LENGTH),
      transcript: this.transcript(history),
      attachments: await this.conversationAttachments(ownRef, chatRun?.id),
    };
  }

  /** The conversation's files: those saved after a finished turn, then a turn still running. */
  private async conversationAttachments(
    sessionId: string,
    activeRunId?: number,
  ) {
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
    const wait = mission.waitJson
      ? (JSON.parse(mission.waitJson) as {
          code?: string;
          previous?: Record<string, unknown>;
        })
      : null;
    // §5.6: a review can start from the execution's waits too.
    const reviewable = [
      'task_review',
      'task_blocked',
      'scope',
      'milestone',
      'final_checks',
      'revision',
    ];
    const late =
      mission.status === 'waiting' && reviewable.includes(wait?.code ?? '');
    if (
      mission.status !== 'briefing' &&
      mission.status !== 'planned' &&
      !late
    ) {
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
      if (late) {
        const previous = wait?.code === 'revision' ? wait.previous : wait;
        // Conditional on the wait read above: an approval in the meantime wins.
        const { count } = await this.prisma.mission.updateMany({
          where: { id, status: 'waiting', waitJson: mission.waitJson },
          data: {
            waitJson: JSON.stringify({ code: 'revision', previous }),
          },
        });
        if (!count) {
          throw new ConflictException(
            'La missione è cambiata nel frattempo: ricarica e riprova',
          );
        }
        const project =
          mission.projectId === null
            ? { id: null, path: this.briefingDir(mission) }
            : await this.projects.get(userId, mission.projectId);
        const run = await this.enqueueReview(mission, project, dto.text ?? '');
        await this.entry(id, 'note', {
          text: dto.text ?? '',
          attachments: (dto.attachments ?? []).map((a) => ({
            name: a.name,
            mediaType: a.mediaType,
          })),
        });
        await this.entry(id, 'turn', { runId: run.id, purpose: 'revision' });
        return { runId: run.id };
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
      const project =
        mission.projectId === null
          ? { id: null, path: this.briefingDir(mission) }
          : await this.projects.get(userId, mission.projectId);
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

  /** §5.6: the revision turn, on the mission's last execution session. */
  private async enqueueReview(
    mission: Mission,
    project: { id: number | null; path: string },
    text: string,
  ) {
    await this.assertOrchestratorConnected(mission.userId);
    const { provider } = await this.runner.check({
      userId: mission.userId,
      project,
      agentSpec: orchestratorAgent(),
      model: mission.orchestratorModel,
    });
    const run = await this.queue.enqueue({
      projectId: project.id,
      userId: mission.userId,
      kind: 'mission-orchestrator',
      title: mission.title,
      input: revisionMessage(text, null),
      sessionId: mission.sessionId,
      model: mission.orchestratorModel,
      provider,
      writes: false,
      missionId: mission.id,
      purposeJson: JSON.stringify({ purpose: 'revision' }),
    });
    await this.entry(mission.id, 'status', { status: 'revision' });
    return run;
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
    const wait = mission.waitJson
      ? (JSON.parse(mission.waitJson) as { code?: string })
      : null;
    // §5.5: a plan proposed during the mission is approved from its wait too.
    const late =
      mission.status === 'waiting' &&
      (wait?.code === 'milestone' || wait?.code === 'revision');
    if (mission.status !== 'planned' && !late) {
      throw new ConflictException("La missione non aspetta un'approvazione");
    }
    if (mission.planVersion !== dto.planVersion) {
      throw new ConflictException('Il piano è cambiato: ricarica e riprova');
    }
    const plan = mission.planJson
      ? planSchema.safeParse(JSON.parse(mission.planJson))
      : null;
    if (!plan?.success) {
      throw new ConflictException(
        'Il piano non è più leggibile: chiedine uno nuovo',
      );
    }
    const project =
      mission.projectId === null
        ? { id: null, path: this.briefingDir(mission) }
        : await this.projects.get(userId, mission.projectId);
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

    const thresholds: BudgetThresholds = {
      fiveHourMinRemaining:
        dto.budget?.fiveHourMinRemaining ??
        plan.data.budget.fiveHourMinRemaining,
      weeklyMaxShare:
        dto.budget?.weeklyMaxShare ?? plan.data.budget.weeklyMaxShare,
      ...(dto.budget?.maxUsd !== undefined
        ? { maxUsd: dto.budget.maxUsd }
        : plan.data.budget.maxUsd !== undefined
          ? { maxUsd: plan.data.budget.maxUsd }
          : {}),
    };

    // §5.1: automatic mode needs plan data, or a dollar cap to enforce.
    if (dto.mode === 'auto' && thresholds.maxUsd === undefined) {
      if (!(await this.budget.hasPlanData(userId))) {
        throw new ConflictException(
          'Imposta un tetto in dollari per la modalità automatica',
        );
      }
    }

    let baseBranch = mission.baseBranch;
    if (!late) {
      const sandbox = await this.sandbox.available();
      if (!sandbox.available) {
        throw new ConflictException(
          `Le missioni richiedono il sandbox, non disponibile su questo sistema${sandbox.reason ? `: ${sandbox.reason}` : ''}`,
        );
      }

      // §1.7: from this phase a mission needs a git repository and a valid base branch.
      baseBranch = plan.data.baseBranch ?? mission.baseBranch ?? 'main';
      // §8.2: a new project has no repository yet: only the branch name matters.
      if (mission.projectId !== null) {
        if (!baseBranch || !(await this.git.isRepository(project.path))) {
          throw new ConflictException('Serve un repository git');
        }
        if (await this.git.remoteHasCredentials(project.path)) {
          throw new ConflictException(
            "Il remote contiene credenziali: rimuovile dall'URL e usa il vault",
          );
        }
        if (!(await this.git.checkRefFormat(project.path, baseBranch))) {
          throw new ConflictException(
            `Il branch base "${baseBranch}" non è valido`,
          );
        }
      }
    }

    // Approving a plan proposed in a milestone review confirms that milestone.
    // Corrective tasks added to it reopen it instead: checks and review run again after them.
    let progressJson: string | undefined;
    if (late && wait?.code === 'milestone') {
      const progress = readProgress(mission);
      const milestone = (wait as { milestone?: string }).milestone;
      const open = milestone
        ? await this.prisma.missionTask.count({
            where: {
              missionId: id,
              milestone,
              status: { notIn: ['done', 'skipped'] },
            },
          })
        : 0;
      if (
        milestone &&
        !open &&
        !progress.reviewedMilestones.includes(milestone)
      ) {
        progress.reviewedMilestones.push(milestone);
        progressJson = JSON.stringify(progress);
      }
    }
    const { count } = await this.prisma.mission.updateMany({
      where: {
        id,
        userId,
        status: mission.status,
        planVersion: dto.planVersion,
      },
      data: {
        status: late ? 'running' : 'approved',
        mode: dto.mode,
        approvedVersion: dto.planVersion,
        approvedAt: new Date(),
        waitJson: null,
        // A plan approved during the mission keeps what the budget already counted.
        budgetJson: JSON.stringify(
          late
            ? rethresholdBudget(readBudget(mission), thresholds)
            : initialBudget(thresholds),
        ),
        ...(baseBranch ? { baseBranch } : {}),
        ...(progressJson ? { progressJson } : {}),
      },
    });
    if (!count)
      throw new ConflictException('Il piano è cambiato: ricarica e riprova');
    await this.entry(id, 'status', {
      status: late ? 'running' : 'approved',
      version: dto.planVersion,
      mode: dto.mode,
    });
    if (late) {
      // The scheduler's timer picks the mission up; the approval is already saved.
    } else {
      await this.queuePrepare(id);
    }
    return this.get(userId, id);
  }

  /** `POST /missions/:id/baseline/retry`: new base, then the preparation again. */
  async retryBaseline(userId: number, id: number) {
    const mission = await this.find(userId, id);
    const wait = mission.waitJson
      ? (JSON.parse(mission.waitJson) as { code?: string })
      : null;
    if (mission.status !== 'waiting' || wait?.code !== 'baseline') {
      throw new ConflictException(
        'La missione non aspetta un nuovo controllo di base',
      );
    }
    const project = await this.projects.get(userId, mission.projectId!);
    if (!mission.baseBranch)
      throw new ConflictException('Serve un repository git');

    const base = await this.git.baseRef(project.path, mission.baseBranch);
    const baseCommit = base.ref
      ? await this.git.revParse(project.path, base.ref)
      : null;
    if (!baseCommit) {
      throw new ConflictException(
        `Il branch "${mission.baseBranch}" non esiste in locale né su origin`,
      );
    }
    if (mission.worktreePath && baseCommit !== mission.baseCommit) {
      const ahead = mission.baseCommit
        ? await this.git.aheadOf(mission.worktreePath, mission.baseCommit)
        : 0;
      if (ahead > 0) {
        throw new ConflictException(
          'Il worktree ha lavoro non unito: non posso ripartire dal nuovo base',
        );
      }
      await this.git.resetTo(mission.worktreePath, baseCommit);
      await this.prisma.mission.update({
        where: { id },
        data: { baseCommit },
      });
    }

    const { count } = await this.prisma.mission.updateMany({
      where: { id, userId, status: 'waiting' },
      data: { status: 'approved', waitJson: null },
    });
    if (!count)
      throw new ConflictException('La missione è cambiata: ricarica e riprova');
    await this.entry(id, 'status', { status: 'approved', retry: true });
    await this.queuePrepare(id);
    return this.get(userId, id);
  }

  /** Queues one `mission-prepare` per mission, unless one is already active. */
  private async queuePrepare(missionId: number) {
    if (this.preparing.has(missionId)) return;
    this.preparing.add(missionId);
    try {
      const mission = await this.prisma.mission.findFirst({
        where: { id: missionId, status: 'approved' },
      });
      if (!mission) return;
      if (await this.activePrepare(missionId)) return;
      const run = await this.queue.enqueue({
        projectId: mission.projectId,
        userId: mission.userId,
        kind: 'mission-prepare',
        title: mission.title,
        input: '',
        writes: false,
        missionId: mission.id,
      });
      await this.entry(mission.id, 'prepare', { runId: run.id });
    } finally {
      this.preparing.delete(missionId);
    }
  }

  private activePrepare(missionId: number) {
    return this.prisma.run.findFirst({
      where: {
        missionId,
        kind: 'mission-prepare',
        status: { in: ACTIVE_STATUSES },
      },
      orderBy: { id: 'desc' },
    });
  }

  async revise(userId: number, id: number) {
    const mission = await this.find(userId, id);
    const wait = mission.waitJson
      ? (JSON.parse(mission.waitJson) as { code?: string })
      : null;
    const reviewable =
      mission.status === 'approved' ||
      (mission.status === 'waiting' && wait?.code === 'baseline');
    if (!reviewable) {
      throw new ConflictException(
        'Solo una missione approvata si può rivedere',
      );
    }
    // Leave `approved` first: reconciliation must not queue a new preparation meanwhile.
    const { count } = await this.prisma.mission.updateMany({
      where: { id, userId, status: mission.status },
      data: {
        status: 'briefing',
        waitJson: null,
        approvedAt: null,
        branch: null,
        worktreePath: null,
        baseCommit: null,
      },
    });
    if (!count) {
      throw new ConflictException('La missione è cambiata: ricarica e riprova');
    }
    const active = await this.prisma.run.findMany({
      where: { missionId: id, status: { in: ACTIVE_STATUSES } },
      select: { id: true },
    });
    for (const run of active) await this.runs.abort(userId, run.id);
    // Let the executor close them before the worktree disappears under a check.
    for (let i = 0; i < 50; i++) {
      const still = await this.prisma.run.count({
        where: { missionId: id, status: { in: ACTIVE_STATUSES } },
      });
      if (!still) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.cleanupWorkspace(mission);
    // The tasks belong to the plan being revised.
    await this.prisma.missionTask.deleteMany({ where: { missionId: id } });
    await this.entry(id, 'status', { status: 'briefing' });
    return this.get(userId, id);
  }

  /** Removes the mission's worktree, branch and setup marker; missing ones are fine. */
  private async cleanupWorkspace(mission: Mission) {
    if (mission.projectId === null) {
      // §8.2: abandoning a new project deletes its briefing folder.
      await rm(this.briefingDir(mission), { recursive: true, force: true }).catch(
        () => undefined,
      );
      return;
    }
    const projectId = mission.projectId;
    const project = await this.projects.get(mission.userId, projectId);
    const dataDir = await this.runConfig.resolvedDataDir();
    const worktree =
      mission.worktreePath ??
      missionWorktreePath(dataDir, projectId, mission.id);
    const branch =
      mission.branch ?? missionBranchName(mission.id, mission.title);
    const tasks = await this.prisma.missionTask.findMany({
      where: { missionId: mission.id },
    });
    for (const task of tasks) {
      const taskWorktree =
        task.worktreePath ??
        taskWorktreePath(dataDir, projectId, mission.id, task.key);
      await this.git
        .removeWorktree(project.path, taskWorktree)
        .catch(() => undefined);
      await this.git
        .deleteBranch(
          project.path,
          task.branch ?? taskBranchName(mission.id, task.key),
        )
        .catch(() => undefined);
      await rm(setupMarker(taskWorktree), { force: true }).catch(() => undefined);
    }
    await this.git
      .removeWorktree(project.path, worktree)
      .catch(() => undefined);
    await this.git.deleteBranch(project.path, branch).catch(() => undefined);
    await rm(setupMarker(worktree), { force: true }).catch(() => undefined);
  }

  async abort(userId: number, id: number) {
    const { status: from, waitJson } = await this.find(userId, id);
    const active = await this.prisma.run.findMany({
      where: { missionId: id, status: { in: ACTIVE_STATUSES } },
      select: { id: true },
    });
    for (const run of active) await this.runs.abort(userId, run.id);
    const { count } = await this.prisma.mission.updateMany({
      where: { id, userId, status: { not: 'aborted' } },
      data: { status: 'aborted', waitJson: null, finishedAt: new Date() },
    });
    // A task running while the mission is stopped ends with it; its worktree stays.
    const stopped = await this.prisma.missionTask.findMany({
      where: {
        missionId: id,
        status: { in: ['running', 'review', 'merging'] },
      },
      select: { id: true, status: true, finishedAt: true },
    });
    await this.prisma.missionTask.updateMany({
      where: { id: { in: stopped.map((task) => task.id) } },
      data: { status: 'aborted', finishedAt: new Date() },
    });
    // What the mission and its tasks were doing: a resume puts them back.
    if (count) {
      await this.entry(id, 'status', {
        status: 'aborted',
        from,
        wait: waitJson ? (JSON.parse(waitJson) as unknown) : null,
        tasks: stopped,
      });
    }
    return this.get(userId, id);
  }

  /**
   * Puts a stopped mission back where it was. Work in progress resumes from
   * the state the stop recorded: the briefing, the preparation, or the tasks
   * (a task cut mid-run goes on from its last checkpoint, see the scheduler).
   */
  async resume(userId: number, id: number) {
    const mission = await this.find(userId, id);
    if (mission.status !== 'aborted') {
      throw new ConflictException('Si riprende solo una missione fermata');
    }
    const active = await this.prisma.run.count({
      where: { missionId: id, status: { in: ACTIVE_STATUSES } },
    });
    if (active) {
      throw new ConflictException(
        'La missione si sta ancora fermando: riprova tra poco',
      );
    }
    const stop = await this.lastStop(id);
    // Integration and a paused window are derived again by the scheduler.
    const status = ['running', 'paused', 'integrating'].includes(stop.from)
      ? 'running'
      : stop.from;
    const wait = status === stop.from && status !== 'approved' ? stop.wait : null;

    const tasks = await this.prisma.missionTask.findMany({
      where: { missionId: id, status: 'aborted' },
    });
    const before = new Map(stop.tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
      const previous = before.get(task.id) ?? {
        status: task.runId ? 'running' : 'pending',
        finishedAt: null,
      };
      // A run can go on only from its worktree; otherwise the task starts over.
      const restored =
        previous.status === 'running' && !(task.runId && task.worktreePath)
          ? 'pending'
          : previous.status;
      await this.prisma.missionTask.update({
        where: { id: task.id },
        data: {
          status: restored,
          finishedAt:
            restored === 'running' || restored === 'pending'
              ? null
              : previous.finishedAt,
        },
      });
    }

    const { count } = await this.prisma.mission.updateMany({
      where: { id, userId, status: 'aborted' },
      data: {
        status,
        waitJson: wait ? JSON.stringify(wait) : null,
        finishedAt: null,
      },
    });
    if (!count) {
      throw new ConflictException('La missione è cambiata: ricarica e riprova');
    }
    await this.entry(id, 'status', { status, resumed: true });
    if (status === 'approved') await this.queuePrepare(id);
    return this.get(userId, id);
  }

  /** The state recorded by the last stop; older stops recorded only the status. */
  private async lastStop(missionId: number) {
    const entries = await this.prisma.missionEntry.findMany({
      where: { missionId, kind: 'status' },
      orderBy: { id: 'desc' },
    });
    const parsed = entries.map(
      (entry) =>
        JSON.parse(entry.dataJson) as {
          status?: string;
          from?: string;
          wait?: unknown;
          tasks?: { id: number; status: string; finishedAt: string | null }[];
        },
    );
    const stopAt = parsed.findIndex((data) => data.status === 'aborted');
    const stop = stopAt >= 0 ? parsed[stopAt] : {};
    const from =
      stop.from ??
      parsed
        .slice(stopAt + 1)
        .find((data) => data.status && data.status !== 'aborted')?.status ??
      'briefing';
    if (!RESUMABLE.includes(from)) {
      throw new ConflictException('Questa missione non si può riprendere');
    }
    return {
      from,
      wait: stop.wait ?? null,
      tasks: (stop.tasks ?? []).map((task) => ({
        id: task.id,
        status: task.status,
        finishedAt: task.finishedAt ? new Date(task.finishedAt) : null,
      })),
    };
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
    await this.cleanupWorkspace(mission);
    await this.prisma.mission.delete({ where: { id } });
  }

  /** Appends to the mission's log and tells the clients following it. */
  record(
    missionId: number,
    kind: string,
    data: unknown,
    extra: { taskId?: number; notify?: boolean } = {},
  ) {
    return this.entry(missionId, kind, data, extra);
  }
}
