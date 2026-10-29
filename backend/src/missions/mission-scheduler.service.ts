import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AgentRunnerService } from '../agents/agent-runner.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { ProjectResourcesService } from '../agents/project-resources.service.js';
import type { Mission, MissionTask } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RunConfig } from '../runs/run-config.js';
import { RunQueueService } from '../runs/run-queue.service.js';
import { readSteps } from '../runs/run-steps.js';
import { ACTIVE_STATUSES } from '../runs/run-types.js';
import { VaultService } from '../vault/vault.service.js';
import {
  BudgetGuard,
  type BudgetGate,
} from './budget-guard.service.js';
import { ChecksService } from './checks.service.js';
import { GitService } from './git-service.js';
import { MissionEventBus } from './mission-event-bus.js';
import { MissionFlowService } from './mission-flow.service.js';
import {
  currentMilestone,
  needsMet,
  readProgress,
} from './mission-progress.js';
import { taskBranchName, taskWorktreePath } from './mission-paths.js';
import { MissionsService } from './missions.service.js';
import { planSchema, planTasks, type Plan, type PlanTask } from './plan-schema.js';
import {
  resetToLastCheckpoint,
} from './task-checkpoints.js';
import {
  TaskGraphFactory,
  type Dependency,
  type TaskGraph,
  type TaskTeam,
} from './task-graph.factory.js';

const TICK_MS = 30_000;

/** A mission's scheduler lock, in memory: one instance, like the event bus. */
class Lock {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = () => resolve()));
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Runs the plan one task at a time, step by step: starts a task, then waits for the user. */
@Injectable()
export class MissionScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MissionScheduler.name);
  private readonly locks = new Map<number, Lock>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: RunConfig,
    private readonly projects: ProjectsService,
    private readonly catalogService: CatalogService,
    private readonly resources: ProjectResourcesService,
    private readonly runner: AgentRunnerService,
    private readonly queue: RunQueueService,
    private readonly git: GitService,
    private readonly checks: ChecksService,
    private readonly vault: VaultService,
    private readonly factory: TaskGraphFactory,
    private readonly missions: MissionsService,
    private readonly budget: BudgetGuard,
    private readonly flow: MissionFlowService,
    private readonly bus: MissionEventBus,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    // Let recovery close the previous process's runs first.
    this.startTimer = setTimeout(() => void this.tick(), 2_000);
    this.startTimer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    if (this.startTimer) clearTimeout(this.startTimer);
  }

  /** Runs a scheduling pass now, or right after the one in progress. */
  wake(missionId?: number) {
    if (missionId !== undefined) {
      void this.withLock(missionId, () => this.pass(missionId)).catch(() => undefined);
      return;
    }
    void this.tick();
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const missions = await this.prisma.mission.findMany({
        where: { status: 'running' },
        select: { id: true },
      });
      // Missions don't wait for each other: final checks of one can take minutes.
      await Promise.all(
        missions.map((mission) =>
          this.withLock(mission.id, () => this.pass(mission.id)).catch(
            (error: unknown) =>
              this.logger.error(
                `Scheduling mission ${mission.id} failed: ${message(error)}`,
              ),
          ),
        ),
      );
    } catch (error) {
      this.logger.error(`Scheduling failed: ${message(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Runs `fn` under the mission's lock; every action and the scheduler share it. */
  withLock<T>(missionId: number, fn: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(missionId);
    if (!lock) this.locks.set(missionId, (lock = new Lock()));
    return lock.run(fn);
  }

  /** The mission's tasks, in plan order, or null when nothing can run. */
  async taskList(mission: Mission) {
    const plan = mission.planJson
      ? planSchema.safeParse(JSON.parse(mission.planJson))
      : null;
    if (!plan?.success) return null;
    await this.ensureTasks(mission, plan.data);
    const rows = await this.prisma.missionTask.findMany({
      where: { missionId: mission.id },
    });
    const order = new Map(
      planTasks(plan.data).map((t, i) => [t.key, i] as const),
    );
    return {
      plan: plan.data,
      tasks: rows.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0)),
    };
  }

  /** Creates the rows of an approved plan once, at the transition to `running`. */
  async ensureTasks(mission: Mission, plan: Plan) {
    const existing = await this.prisma.missionTask.count({
      where: { missionId: mission.id },
    });
    if (existing) return;
    const rows = planTasks(plan).map((task) => ({
      missionId: mission.id,
      key: task.key,
      milestone: task.milestone,
      status: 'pending',
    }));
    await this.prisma.missionTask.createMany({ data: rows });
  }

  private async pass(missionId: number) {
    const mission = await this.prisma.mission.findUnique({
      where: { id: missionId },
    });
    if (!mission || mission.status !== 'running') return;
    const list = await this.taskList(mission);
    if (!list) return;
    const { plan, tasks } = list;

    // A task left running while its process died goes on from its checkpoint.
    const taskRuns = await Promise.all(
      tasks
        .filter((t) => ['running', 'review', 'merging'].includes(t.status))
        .map(async (task) => ({ task, run: await this.taskRun(task) })),
    );
    for (const { task, run } of taskRuns) {
      if (task.status !== 'running') continue;
      if (run && (ACTIVE_STATUSES as string[]).includes(run.status)) continue;
      if (run && run.status === 'interrupted') {
        await this.requeue(task, run);
        continue;
      }
      // A task whose run ended without closing the task (a crash after the run).
      if (run && ['done', 'failed', 'aborted'].includes(run.status)) {
        await this.blockTask(mission.id, task.id, 'error', 'Il run del task è terminato senza chiuderlo');
      }
    }
    if (await this.flow.busy(mission.id)) return;
    // Step by step runs one task at a time. Automatic mode goes on while tasks
    // run: it merges the ready ones and fills the free slots. A task left in
    // `merging` by a crash is settled by both.
    if (
      mission.mode !== 'auto' &&
      taskRuns.some(({ task }) => task.status !== 'merging')
    ) {
      return;
    }

    const taskRows = await this.prisma.missionTask.findMany({
      where: { missionId },
    });
    if (mission.mode === 'auto') {
      await this.autoPass(mission, plan, taskRows);
    } else {
      await this.stepPass(mission, plan, taskRows);
    }
  }

  /** §5.1: step by step, one task at a time, and the user's Ok before each merge. */
  private async stepPass(mission: Mission, plan: Plan, taskRows: MissionTask[]) {
    const byKey = new Map(taskRows.map((t) => [t.key, t]));
    const ordered = planTasks(plan)
      .map((t) => byKey.get(t.key))
      .filter((t): t is MissionTask => Boolean(t));
    const planned = (key: string) => planTasks(plan).find((t) => t.key === key)!;
    const status = new Map(taskRows.map((t) => [t.key, t.status]));

    // Tasks queued for a merge before switching to step by step are merged.
    const merging = taskRows.find((t) => t.status === 'merging');
    if (merging) {
      await this.recoverMerge(mission, plan, merging);
      return;
    }
    const ready = taskRows
      .filter((t) => t.status === 'ready')
      .sort(
        (a, b) =>
          (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0) ||
          a.id - b.id,
      );
    if (ready.length) {
      await this.mergeTask(mission, plan, ready[0]);
      return;
    }

    const pending = ordered.find(
      (task) => task.status === 'pending' && needsMet(planned(task.key), status),
    );
    if (pending) {
      const gate = await this.budget.gate(mission.id, this.modelOf(plan));
      if (!gate.ok) {
        await this.budgetWait(mission, gate);
        return;
      }
      await this.start(mission, plan, planned(pending.key), pending);
      return;
    }

    const open = ordered.filter(
      (t) => t.status !== 'done' && t.status !== 'skipped' && t.status !== 'aborted',
    );
    if (open.length) {
      const blocked =
        open.find((t) => t.status === 'blocked') ??
        open.find((t) => t.status === 'scope') ??
        open
          .map((t) =>
            planned(t.key).needs
              .map((need) => byKey.get(need))
              .find((need) => need?.status === 'blocked' || need?.status === 'scope'),
          )
          .find((need): need is MissionTask => Boolean(need)) ??
        open[0];
      await this.waitTask(mission, blocked);
      return;
    }

    await this.flow.queueChecks(mission, 'final');
  }

  /** §5.1: automatic mode runs a milestone in parallel, merges its tasks, then reviews it. */
  private async autoPass(
    mission: Mission,
    plan: Plan,
    taskRows: MissionTask[],
  ) {
    const byKey = new Map(taskRows.map((t) => [t.key, t]));
    const planned = (key: string) => planTasks(plan).find((t) => t.key === key)!;
    const status = new Map(taskRows.map((t) => [t.key, t.status]));
    const progress = readProgress(mission);

    // One merge at a time, in the order the tasks finished.
    const merging = taskRows.find((t) => t.status === 'merging');
    if (merging) {
      await this.recoverMerge(mission, plan, merging);
      return;
    }
    const ready = taskRows
      .filter((t) => t.status === 'ready')
      .sort(
        (a, b) =>
          (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0) ||
          a.id - b.id,
      );
    if (ready.length) {
      await this.mergeTask(mission, plan, ready[0]);
      return;
    }

    const current = currentMilestone(plan, taskRows, progress);
    if (!current) {
      await this.flow.queueChecks(mission, 'final');
      return;
    }
    const inMilestone = taskRows.filter((t) => t.milestone === current.id);
    const open = inMilestone.filter(
      (t) => t.status !== 'done' && t.status !== 'skipped',
    );

    // The milestone is over: its checks, then the orchestrator's review.
    if (!open.length) {
      if (!progress.reviewedMilestones.includes(current.id)) {
        const checked = await this.lastChecks(mission.id, current.id, inMilestone);
        if (!checked) {
          await this.flow.queueChecks(mission, 'milestone', {
            milestone: current.id,
          });
          return;
        }
        await this.flow.reviewMilestone(mission.id, current.id, checked);
      }
      return;
    }

    const running = inMilestone.filter((t) => t.status === 'running').length;
    const globalRunning = await this.prisma.run.count({
      where: {
        kind: 'mission-task',
        status: { in: ['running', 'queued'] },
      },
    });
    let slots = Math.min(
      plan.parallelTasks - running,
      this.config.limits().missionTasks - globalRunning,
    );
    if (slots <= 0) return;

    const runnable = planTasks(plan)
      .filter((task) => task.milestone === current.id)
      .map((task) => byKey.get(task.key))
      .filter(
        (task): task is MissionTask =>
          Boolean(
            task &&
              task.status === 'pending' &&
              needsMet(planned(task.key), status),
          ),
      );
    let started = 0;
    for (const task of runnable) {
      if (slots <= 0) break;
      const gate = await this.budget.gate(mission.id, this.modelOf(plan));
      if (!gate.ok) {
        await this.budgetWait(mission, gate);
        return;
      }
      await this.start(mission, plan, planned(task.key), task);
      slots -= 1;
      started += 1;
    }
    if (started || running > 0) return;

    // Nothing starts and nothing runs: a block stops its dependents, not the mission.
    const stopped =
      open.find((t) => t.status === 'blocked' || t.status === 'scope') ??
      open
        .map((t) =>
          planned(t.key).needs
            .map((need) => byKey.get(need))
            .find((need) => need?.status === 'blocked' || need?.status === 'scope'),
        )
        .find((need): need is MissionTask => Boolean(need)) ??
      open[0];
    await this.waitTask(mission, stopped);
  }

  /**
   * The latest checks entry of a milestone, as the review turn receives it.
   * Checks older than the last task closed (a corrective one) don't count.
   */
  private async lastChecks(
    missionId: number,
    milestone: string,
    tasks: MissionTask[],
  ) {
    const entry = await this.prisma.missionEntry.findFirst({
      where: {
        missionId,
        kind: 'checks',
        dataJson: { contains: `"milestone":"${milestone}"` },
      },
      orderBy: { id: 'desc' },
    });
    if (!entry) return null;
    const lastClosed = Math.max(
      0,
      ...tasks.map((task) => task.finishedAt?.getTime() ?? 0),
    );
    if (entry.createdAt.getTime() < lastClosed) return null;
    const data = JSON.parse(entry.dataJson) as {
      ok?: boolean;
      results?: { name: string; ok: boolean; exitCode: number | null; durationMs: number }[];
    };
    return { ok: data.ok ?? false, results: data.results ?? [] };
  }

  /** §5.1: the mission waits only when nothing runs, no merge is queued and nothing can start. */
  private async waitTask(mission: Mission, task: MissionTask) {
    const scope =
      task.status === 'scope' && task.reportJson
        ? (JSON.parse(task.reportJson) as { violations?: unknown }).violations
        : undefined;
    const wait =
      task.status === 'scope'
        ? { code: 'scope', taskId: task.id, violations: scope }
        : { code: 'task_blocked', taskId: task.id };
    const { count } = await this.prisma.mission.updateMany({
      where: { id: mission.id, status: 'running' },
      data: { status: 'waiting', waitJson: JSON.stringify(wait) },
    });
    if (!count) return;
    await this.missions.record(mission.id, 'wait', wait, {
      taskId: task.id,
      notify: true,
    });
  }

  /** §5.3: a clean merge ends the task; a conflict stays open for the integrator. */
  private async mergeTask(
    mission: Mission,
    plan: Plan,
    task: MissionTask,
  ) {
    if (!mission.worktreePath) {
      await this.blockTask(mission.id, task.id, 'error', 'Il worktree della missione manca');
      return;
    }
    const branch = task.branch ?? taskBranchName(mission.id, task.key);
    const title =
      planTasks(plan).find((t) => t.key === task.key)?.title ?? task.key;
    const { count } = await this.prisma.missionTask.updateMany({
      where: { id: task.id, status: 'ready' },
      data: { status: 'merging' },
    });
    if (!count) return;
    await this.missions.record(
      mission.id,
      'status',
      { status: 'merging', taskId: task.id },
      { taskId: task.id },
    );

    try {
      await this.git.merge(
        mission.worktreePath,
        branch,
        `Merge task ${task.key}: ${title}`,
      );
    } catch {
      // The merge stays open: the integrator resolves it in the mission's worktree.
      try {
        await this.queue.enqueue({
          projectId: mission.projectId!,
          userId: mission.userId,
          kind: 'mission-integrate',
          title: `${mission.title} · ${task.key}`,
          input: JSON.stringify({ taskId: task.id }),
          missionId: mission.id,
          missionTaskId: task.id,
          writes: false,
        });
      } catch (error) {
        await this.git.abortMerge(mission.worktreePath);
        await this.blockTask(
          mission.id,
          task.id,
          'error',
          `Integratore non avviato: ${message(error)}`,
        );
      }
      return;
    }

    const project = await this.projects.get(mission.userId, mission.projectId!);
    if (task.worktreePath) {
      await this.git
        .removeWorktree(project.path, task.worktreePath)
        .catch(() => undefined);
    }
    const { count: moved } = await this.prisma.missionTask.updateMany({
      where: { id: task.id, status: 'merging' },
      data: { status: 'done', finishedAt: new Date(), worktreePath: null },
    });
    if (!moved) return;
    const progress = readProgress(mission);
    const queue = (progress.mergeQueue ?? []).filter((id) => id !== task.id);
    await this.prisma.mission.update({
      where: { id: mission.id },
      data: { progressJson: JSON.stringify({ ...progress, mergeQueue: queue }) },
    });
    await this.missions.record(
      mission.id,
      'status',
      { status: 'done', taskId: task.id },
      { taskId: task.id },
    );
  }

  /** A merge left open by a crash: conflicts go to the integrator, otherwise it is settled. */
  private async recoverMerge(
    mission: Mission,
    plan: Plan,
    task: MissionTask,
  ) {
    if (!mission.worktreePath) return;
    const conflicts = await this.git.conflicts(mission.worktreePath).catch(() => []);
    if (conflicts.length) {
      await this.queue
        .enqueue({
          projectId: mission.projectId!,
          userId: mission.userId,
          kind: 'mission-integrate',
          title: `${mission.title} · ${task.key}`,
          input: JSON.stringify({ taskId: task.id }),
          missionId: mission.id,
          missionTaskId: task.id,
          writes: false,
        })
        .catch(() => undefined);
      return;
    }
    const branch = task.branch ?? taskBranchName(mission.id, task.key);
    const merged = await this.git
      .aheadOfRef(mission.worktreePath, 'HEAD', branch)
      .catch(() => 0);
    if (!merged) {
      await this.blockTask(
        mission.id,
        task.id,
        'error',
        `Il merge di ${task.key} è aperto senza conflitti`,
      );
      return;
    }
    // The merge went through before the crash: close the task as a clean merge.
    const project = await this.projects.get(mission.userId, mission.projectId!);
    if (task.worktreePath) {
      await this.git
        .removeWorktree(project.path, task.worktreePath)
        .catch(() => undefined);
    }
    const { count } = await this.prisma.missionTask.updateMany({
      where: { id: task.id, status: 'merging' },
      data: { status: 'done', finishedAt: new Date(), worktreePath: null },
    });
    if (count) {
      await this.missions.record(
        mission.id,
        'status',
        { status: 'done', taskId: task.id, recovered: true },
        { taskId: task.id },
      );
    }
    void plan;
  }

  /** Starts one task: branch, worktree, setup, graph, run. */
  /** The model the first agent of a task will use: the implementer role, or the orchestrator's. */
  private modelOf(plan: Plan) {
    return plan.team.roles.implementer?.model ?? plan.team.orchestrator;
  }

  /** §2.5: the mission stops where the gate says, and the log says why. */
  private async budgetWait(
    mission: Mission,
    gate: Exclude<BudgetGate, { ok: true }>,
  ) {
    const until = 'until' in gate ? gate.until : undefined;
    const pause = gate.kind === 'five_hour' || gate.kind === 'model_window';
    const wait =
      gate.kind === 'five_hour' || gate.kind === 'model_window'
        ? {
            code: gate.kind,
            ...(until ? { until } : {}),
            ...(gate.kind === 'model_window' ? { window: gate.window } : {}),
          }
        : gate.kind === 'weekly_mission' || gate.kind === 'weekly_global'
          ? {
              code: 'weekly_budget',
              scope:
                gate.kind === 'weekly_global' ? 'global' : ('mission' as const),
              ...(until ? { until } : {}),
            }
          : { code: 'usd_budget' };
    const { count } = await this.prisma.mission.updateMany({
      where: { id: mission.id, status: 'running' },
      data: {
        status: pause ? 'paused' : 'waiting',
        waitJson: JSON.stringify(wait),
      },
    });
    if (!count) return;
    await this.missions.record(mission.id, 'budget', wait, { notify: true });
  }

  private async start(
    mission: Mission,
    plan: Plan,
    planTask: PlanTask & { milestone: string },
    task: MissionTask,
  ) {
    const project = await this.projects.get(mission.userId, mission.projectId!);
    const missionTip =
      (mission.worktreePath
        ? await this.git.revParse(mission.worktreePath, 'HEAD')
        : null) ?? mission.baseCommit;
    if (!missionTip) {
      await this.blockTask(mission.id, task.id, 'config', 'La missione non ha un commit di partenza');
      return;
    }

    const branch = taskBranchName(mission.id, task.key);
    const dataDir = await this.config.resolvedDataDir();
    const worktree =
      task.worktreePath ??
      taskWorktreePath(dataDir, mission.projectId!, mission.id, task.key);

    try {
      const existing = await this.git.revParse(
        mission.worktreePath ?? project.path,
        `refs/heads/${branch}`,
      );
      if (!existing) {
        await this.git.createBranch(project.path, branch, missionTip);
      } else if (existing !== missionTip) {
        await this.git.moveBranch(project.path, branch, missionTip);
      }
      await mkdir(dirname(worktree), { recursive: true });
      await this.git.addWorktree(project.path, worktree, branch);
      if (task.taskBase && task.taskBase !== missionTip) {
        await this.git.resetTo(worktree, missionTip);
      }
    } catch (error) {
      await this.blockTask(mission.id, task.id, 'error', message(error));
      return;
    }

    const { catalog, enabled } = await this.context(mission);
    const template = catalog.workflows.get(planTask.template);
    if (!template?.task) {
      await this.blockTask(
        mission.id,
        task.id,
        'config',
        `Il modello di task "${planTask.template}" non è disponibile`,
      );
      return;
    }
    const team: TaskTeam = {
      roles: plan.team.roles,
      custom: plan.team.custom,
      agents: catalog.agents,
    };
    let graph: TaskGraph;
    try {
      graph = this.factory.build(mission, plan, planTask, template, team);
    } catch (error) {
      await this.blockTask(mission.id, task.id, 'config', message(error));
      return;
    }
    const unavailable = this.factory.unavailable(graph, catalog, enabled);
    if (unavailable.length) {
      await this.blockTask(mission.id, task.id, 'config', unavailable.join('\n'));
      return;
    }
    try {
      for (const agent of Object.values(graph.agents)) {
        await this.runner.check({
          userId: mission.userId,
          project,
          agentSpec: agent.spec,
        });
      }
    } catch (error) {
      await this.blockTask(mission.id, task.id, 'config', message(error));
      return;
    }

    const outputs = await this.dependencies(mission, plan, planTask, missionTip);
    const attempt = {
      notes: this.factory.notes(task),
      previous: previousOf(task),
    };
    const text = this.factory.text(mission, plan, planTask, attempt, outputs);

    // The mission may have been stopped while the worktree was being prepared.
    const current = await this.prisma.mission.findUnique({
      where: { id: mission.id },
      select: { status: true },
    });
    if (current?.status !== 'running') return;

    // The task is ready before the scheduler can start the run: `prepare` runs
    // while the queue still holds it back.
    await this.queue.enqueue(
      {
        projectId: mission.projectId!,
        userId: mission.userId,
        kind: 'mission-task',
        title: `${mission.title} · ${task.key}`,
        input: text,
        missionId: mission.id,
        missionTaskId: task.id,
        specJson: JSON.stringify(graph),
        stepsJson: '[]',
        writes: false,
      },
      async (run) => {
        await this.prisma.$transaction(async (tx) => {
          await tx.missionTask.update({
            where: { id: task.id },
            data: {
              status: 'running',
              branch,
              worktreePath: worktree,
              taskBase: missionTip,
              runId: run.id,
              startedAt: new Date(),
              finishedAt: null,
            },
          });
          await tx.missionEntry.create({
            data: {
              missionId: mission.id,
              taskId: task.id,
              kind: 'status',
              dataJson: JSON.stringify({
                status: 'running',
                taskId: task.id,
                runId: run.id,
                attempt: task.attempts,
              }),
            },
          });
        });
      },
    );
  }

  private async context(mission: Mission) {
    const catalog = await this.catalogService.forProject(
      mission.userId,
      mission.projectId!,
    );
    const enabled = await this.resources.isEnabled(mission.projectId!, catalog);
    return { catalog, enabled };
  }

  private async dependencies(
    mission: Mission,
    plan: Plan,
    task: PlanTask & { milestone: string },
    tip: string,
  ): Promise<Dependency[]> {
    const rows = await this.prisma.missionTask.findMany({
      where: { missionId: mission.id, key: { in: task.needs } },
    });
    const byKey = new Map(rows.map((t) => [t.key, t]));
    const all = planTasks(plan);
    return task.needs.map((key) => {
      const row = byKey.get(key);
      const planned = all.find((t) => t.key === key);
      const report = row?.reportJson
        ? (JSON.parse(row.reportJson) as { summary?: string })
        : null;
      return {
        key,
        title: planned?.title ?? key,
        summary: report?.summary ?? '',
        // A task starts from the mission's tip: the merged dependencies are there.
        commit: row?.status === 'done' ? tip : '',
        skipped: row?.status === 'skipped',
      };
    });
  }

  /** After a resume: a task stopped mid-run goes on from its last checkpoint. */
  async resumeTasks(missionId: number) {
    const tasks = await this.prisma.missionTask.findMany({
      where: { missionId, status: 'running' },
    });
    for (const task of tasks) {
      const run = await this.taskRun(task);
      if (run?.status === 'aborted') await this.requeue(task, run);
    }
  }

  private async taskRun(task: MissionTask) {
    if (!task.runId) return null;
    return this.prisma.run.findUnique({ where: { id: task.runId } });
  }

  /** Queues an interrupted task run again, from its last checkpoint. */
  private async requeue(task: MissionTask, run: NonNullable<Awaited<ReturnType<MissionScheduler['taskRun']>>>) {
    if (!task.worktreePath) return;
    try {
      const steps = readSteps(run.stepsJson);
      const kept = Object.fromEntries(
        Object.entries(steps).filter(([, s]) => s.status === 'done'),
      );
      await resetToLastCheckpoint(this.git, task.worktreePath, steps, task.taskBase ?? '');
      await this.queue.enqueue(
        {
          projectId: run.projectId,
          userId: run.userId,
          kind: 'mission-task',
          title: run.title,
          input: run.input,
          missionId: task.missionId,
          missionTaskId: task.id,
          specJson: run.specJson,
          stepsJson: JSON.stringify(kept),
          writes: false,
          resumeOf: run.id,
        },
        async (created) => {
          await this.prisma.missionTask.update({
            where: { id: task.id },
            data: { runId: created.id },
          });
        },
      );
    } catch (error) {
      await this.blockTask(task.missionId, task.id, 'error', message(error));
    }
  }

  private async blockTask(
    missionId: number,
    taskId: number,
    reason: 'config' | 'error',
    detail: string,
  ) {
    const report = {
      attempt: 0,
      diff: { files: [], added: 0, removed: 0 },
      checks: [],
      review: null,
      iterations: 0,
      warnings: [],
      costUsd: 0,
      blocked: { reason, detail },
      summary: '',
    };
    const last = await this.prisma.missionEntry.aggregate({
      where: { missionId },
      _max: { id: true },
    });
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.missionTask.updateMany({
        where: { id: taskId, status: { in: ['pending', 'running'] } },
        data: { status: 'blocked', finishedAt: new Date(), reportJson: JSON.stringify(report) },
      });
      if (!moved.count) return;
      const wait = { code: 'task_blocked', taskId };
      await tx.mission.updateMany({
        where: { id: missionId, status: 'running' },
        data: { status: 'waiting', waitJson: JSON.stringify(wait) },
      });
      await tx.missionEntry.create({
        data: {
          missionId,
          taskId,
          kind: 'wait',
          dataJson: JSON.stringify({ ...wait, report }),
          notify: true,
        },
      });
      await tx.missionEntry.create({
        data: {
          missionId,
          taskId,
          kind: 'status',
          dataJson: JSON.stringify({ status: 'blocked', taskId, reason }),
        },
      });
    });
    const rows = await this.prisma.missionEntry.findMany({
      where: { missionId, id: { gt: last._max.id ?? 0 } },
      orderBy: { id: 'asc' },
    });
    for (const row of rows) this.bus.publish(row);
  }

}

function previousOf(task: MissionTask) {
  const report = task.reportJson
    ? (JSON.parse(task.reportJson) as { previous?: { diff: string; review: string } })
    : null;
  return report?.previous;
}

