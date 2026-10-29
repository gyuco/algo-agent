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
import { ChecksService, type CheckResult } from './checks.service.js';
import { GitService } from './git-service.js';
import {
  missionBranchName,
  taskBranchName,
  taskWorktreePath,
} from './mission-paths.js';
import { MissionsService } from './missions.service.js';
import { planSchema, planTasks, type Plan, type PlanTask } from './plan-schema.js';
import {
  TaskGraphFactory,
  type Dependency,
  type TaskGraph,
  type TaskTeam,
} from './task-graph.factory.js';

const TICK_MS = 30_000;
const DETAIL_LINES = 5;
const DETAIL_LENGTH = 500;

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

function detailOf(result: CheckResult) {
  const detail = result.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, DETAIL_LINES)
    .join('\n')
    .slice(0, DETAIL_LENGTH);
  if (result.timedOut) return ['Timeout del comando', detail].filter(Boolean).join('\n');
  return detail || `Exit code ${result.exitCode ?? 'sconosciuto'}`;
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
    if (taskRuns.length) return;

    const taskRows = await this.prisma.missionTask.findMany({
      where: { missionId },
    });
    const byKey = new Map(taskRows.map((t) => [t.key, t]));
    const ordered = planTasks(plan)
      .map((t) => byKey.get(t.key))
      .filter((t): t is MissionTask => Boolean(t));

    const pending = ordered.find(
      (task) =>
        task.status === 'pending' &&
        planTasks(plan)
          .find((t) => t.key === task.key)!
          .needs.every((need) => {
            const status = byKey.get(need)?.status;
            return status === 'done' || status === 'skipped';
          }),
    );
    if (pending) {
      const planTask = planTasks(plan).find((t) => t.key === pending.key)!;
      await this.start(mission, plan, planTask, pending);
      return;
    }

    const open = ordered.filter(
      (t) => t.status !== 'done' && t.status !== 'skipped' && t.status !== 'aborted',
    );
    if (open.length) {
      const blocked =
        open.find((t) => t.status === 'blocked') ??
        open
          .map((t) =>
            planTasks(plan)
              .find((p) => p.key === t.key)!
              .needs.map((need) => byKey.get(need))
              .find((need) => need?.status === 'blocked'),
          )
          .find((need): need is MissionTask => Boolean(need)) ??
        open[0];
      const wait = { code: 'task_blocked', taskId: blocked.id };
      const { count } = await this.prisma.mission.updateMany({
        where: { id: mission.id, status: 'running' },
        data: { status: 'waiting', waitJson: JSON.stringify(wait) },
      });
      if (count) {
        await this.missions.record(
          mission.id,
          'wait',
          wait,
          { taskId: blocked.id, notify: true },
        );
      }
      return;
    }

    await this.finalChecks(mission, plan);
  }

  /** Starts one task: branch, worktree, setup, graph, run. */
  private async start(
    mission: Mission,
    plan: Plan,
    planTask: PlanTask & { milestone: string },
    task: MissionTask,
  ) {
    const project = await this.projects.get(mission.userId, mission.projectId);
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
      taskWorktreePath(dataDir, mission.projectId, mission.id, task.key);

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
        projectId: mission.projectId,
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
      mission.projectId,
    );
    const enabled = await this.resources.isEnabled(mission.projectId, catalog);
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
      const checkpoint =
        Object.values(steps)
          .map((s) => s.checkpoint)
          .filter((c): c is string => Boolean(c))
          .at(-1) ?? task.taskBase;
      if (checkpoint) await this.git.resetTo(task.worktreePath, checkpoint);
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
  }

  /** The full checks of the mission's worktree, then `done` or `final_checks`. */
  private async finalChecks(mission: Mission, plan: Plan) {
    const wait = mission.waitJson
      ? (JSON.parse(mission.waitJson) as { code?: string })
      : null;
    if (mission.status === 'waiting' && wait?.code === 'final_checks') return;
    if (!mission.worktreePath) {
      await this.blockFinal(mission, 'Il worktree della missione manca');
      return;
    }
    const all = await this.vault.variables(mission.userId, mission.projectId);
    const secrets = Object.fromEntries(
      plan.checks.secrets
        .filter((name) => name in all)
        .map((name) => [name, all[name]]),
    );
    const names = (['setup', 'build', 'lint', 'test'] as const).filter(
      (name) => name === 'test' || plan.checks[name],
    );
    let results: CheckResult[];
    try {
      results = await this.checks.run({
        runId: undefined,
        projectId: mission.projectId,
        worktree: mission.worktreePath,
        plan,
        names: [...names],
        secrets,
        signal: new AbortController().signal,
      });
    } catch (error) {
      await this.blockFinal(mission, message(error));
      return;
    }
    const failed = results.find((r) => !r.ok);
    if (failed) {
      await this.blockFinal(mission, detailOf(failed));
      return;
    }
    const branch = mission.branch ?? missionBranchName(mission.id, plan.title);
    const { count } = await this.prisma.mission.updateMany({
      where: { id: mission.id, status: 'running' },
      data: { status: 'done', finishedAt: new Date(), waitJson: null },
    });
    if (!count) return;
    await this.missions.record(
      mission.id,
      'status',
      { status: 'done', branch },
      { notify: true },
    );
    await this.missions.record(
      mission.id,
      'final',
      { branch, files: results.length },
      { notify: true },
    );
  }

  private async blockFinal(mission: Mission, detail: string) {
    const wait = { code: 'final_checks', detail };
    const { count } = await this.prisma.mission.updateMany({
      where: { id: mission.id, status: 'running' },
      data: { status: 'waiting', waitJson: JSON.stringify(wait) },
    });
    if (!count) return;
    await this.missions.record(mission.id, 'wait', wait, { notify: true });
  }
}

function previousOf(task: MissionTask) {
  const report = task.reportJson
    ? (JSON.parse(task.reportJson) as { previous?: { diff: string; review: string } })
    : null;
  return report?.previous;
}

