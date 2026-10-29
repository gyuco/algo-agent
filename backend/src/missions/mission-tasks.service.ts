import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RunConfig } from '../runs/run-config.js';
import { listSteps, readSteps } from '../runs/run-steps.js';
import { GitService } from './git-service.js';
import {
  missionBranchName,
  taskBranchName,
  taskWorktreePath,
} from './mission-paths.js';
import { MissionScheduler } from './mission-scheduler.service.js';
import { taskView, type TaskReport } from './mission-task.handler.js';
import { MissionsService } from './missions.service.js';
import { planSchema, planTasks, type Plan } from './plan-schema.js';

interface Wait {
  code?: string;
  taskId?: number;
  detail?: string;
}

/** The tasks of a mission and the user's actions on them. */
@Injectable()
export class MissionTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly missions: MissionsService,
    private readonly scheduler: MissionScheduler,
    private readonly projects: ProjectsService,
    private readonly git: GitService,
    private readonly config: RunConfig,
  ) {}

  private async find(userId: number, missionId: number, key: string) {
    const mission = await this.prisma.mission.findFirst({
      where: { id: missionId, userId },
    });
    if (!mission) throw new NotFoundException('Missione non trovata');
    const task = await this.prisma.missionTask.findFirst({
      where: { missionId, key },
    });
    if (!task) throw new NotFoundException('Task non trovato');
    const plan = mission.planJson
      ? planSchema.safeParse(JSON.parse(mission.planJson))
      : null;
    if (!plan?.success) throw new ConflictException('Il piano non è leggibile');
    return { mission, task, plan: plan.data };
  }

  private wait(mission: { waitJson: string | null }): Wait | null {
    return mission.waitJson ? (JSON.parse(mission.waitJson) as Wait) : null;
  }

  /** The mission's tasks, in plan order, as the list shows them. */
  async list(userId: number, missionId: number) {
    const mission = await this.prisma.mission.findFirst({
      where: { id: missionId, userId },
    });
    if (!mission) throw new NotFoundException('Missione non trovata');
    const plan = mission.planJson
      ? planSchema.safeParse(JSON.parse(mission.planJson))
      : null;
    if (!plan?.success) return { tasks: [] };
    const rows = await this.prisma.missionTask.findMany({
      where: { missionId },
    });
    const byKey = new Map(rows.map((t) => [t.key, t]));
    const tasks = [];
    for (const planned of planTasks(plan.data)) {
      const row = byKey.get(planned.key);
      if (!row) continue;
      const waitingOn = planned.needs.filter((need) => {
        const status = byKey.get(need)?.status;
        return status !== 'done' && status !== 'skipped';
      });
      tasks.push({
        ...taskView(row, plan.data, waitingOn),
        milestone: planned.milestone,
        title: planned.title ?? planned.key,
      });
    }
    return { tasks };
  }

  /** One task with the whole report and the runs of every attempt. */
  async get(userId: number, missionId: number, key: string) {
    const { task, plan } = await this.find(userId, missionId, key);
    const planned = planTasks(plan).find((t) => t.key === key);
    const runs = await this.prisma.run.findMany({
      where: { missionTaskId: task.id },
      orderBy: { id: 'desc' },
    });
    const rows = await this.prisma.missionTask.findMany({
      where: { missionId },
    });
    const byKey = new Map(rows.map((t) => [t.key, t]));
    const waitingOn = (planned?.needs ?? []).filter((need) => {
      const status = byKey.get(need)?.status;
      return status !== 'done' && status !== 'skipped';
    });
    return {
      id: task.id,
      key: task.key,
      missionId: task.missionId,
      milestone: planned?.milestone ?? task.milestone,
      title: planned?.title ?? task.key,
      status: task.status,
      attempts: task.attempts,
      runId: task.runId,
      branch: task.branch,
      taskBase: task.taskBase,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      report: this.reportOf(task.reportJson),
      waitingOn,
      runs: runs.map((run) => ({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        costUsd: run.costUsd,
        error: run.error,
        steps: listSteps(readSteps(run.stepsJson)),
      })),
    };
  }

  /** The unified diff of the current attempt. */
  async diff(userId: number, missionId: number, key: string) {
    const { mission, task } = await this.find(userId, missionId, key);
    if (!task.taskBase) return '';
    const branch = task.branch ?? taskBranchName(missionId, task.key);
    // The worktree is gone after the merge; the branch still holds the task's commit.
    if (!task.worktreePath) {
      const project = await this.projects.get(userId, mission.projectId);
      return this.git
        .diffText(project.path, task.taskBase, branch)
        .catch(() => '');
    }
    return this.git.diffText(task.worktreePath, task.taskBase, branch);
  }

  /** Ok: merge the task's branch into the mission's worktree, then `done`. */
  async ok(userId: number, missionId: number, key: string) {
    return this.scheduler.withLock(missionId, async () => {
      const { mission, task, plan } = await this.find(userId, missionId, key);
      const wait = this.wait(mission);
      if (task.status !== 'review' || wait?.code !== 'task_review' || wait.taskId !== task.id) {
        throw new ConflictException('Il task non aspetta un Ok');
      }
      if (!mission.worktreePath) {
        throw new ConflictException('Il worktree della missione manca');
      }
      const branch = task.branch ?? taskBranchName(missionId, task.key);
      const title =
        planTasks(plan).find((t) => t.key === task.key)?.title ?? task.key;
      const { count } = await this.prisma.missionTask.updateMany({
        where: { id: task.id, status: 'review' },
        data: { status: 'merging' },
      });
      if (!count) throw new ConflictException('Il task sta cambiando: riprova');
      await this.missions.record(
        missionId,
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
      } catch (error) {
        await this.git.abortMerge(mission.worktreePath);
        const detail =
          error instanceof Error ? error.message : String(error);
        const report = this.withBlocked(task, 'merge', detail);
        await this.prisma.$transaction(async (tx) => {
          await tx.missionTask.update({
            where: { id: task.id },
            data: { status: 'blocked', reportJson: JSON.stringify(report) },
          });
          const next = { code: 'task_blocked', taskId: task.id };
          await tx.mission.update({
            where: { id: missionId },
            data: { status: 'waiting', waitJson: JSON.stringify(next) },
          });
          await tx.missionEntry.create({
            data: {
              missionId,
              taskId: task.id,
              kind: 'wait',
              dataJson: JSON.stringify(next),
              notify: true,
            },
          });
        });
        this.scheduler.wake(missionId);
        throw new ConflictException(`Merge in conflitto: ${detail}`);
      }

      const project = await this.projects.get(userId, mission.projectId);
      // The merge is done: a worktree that won't go away must not leave the task in `merging`.
      if (task.worktreePath) {
        await this.git
          .removeWorktree(project.path, task.worktreePath)
          .catch(() => undefined);
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.missionTask.update({
          where: { id: task.id },
          data: {
            status: 'done',
            finishedAt: new Date(),
            worktreePath: null,
          },
        });
        const { count: moved } = await tx.mission.updateMany({
          where: { id: missionId, status: 'waiting' },
          data: { status: 'running', waitJson: null },
        });
        await tx.missionEntry.create({
          data: {
            missionId,
            taskId: task.id,
            kind: 'status',
            dataJson: JSON.stringify({ status: 'done', taskId: task.id }),
          },
        });
        if (moved) {
          await tx.missionEntry.create({
            data: {
              missionId,
              taskId: task.id,
              kind: 'status',
              dataJson: JSON.stringify({ status: 'running', taskId: task.id }),
            },
          });
        }
      });
      this.scheduler.wake(missionId);
      return this.missions.get(userId, missionId);
    });
  }

  /** "Rifai con nota": the branch goes back to the mission's tip and the task runs again. */
  async redo(userId: number, missionId: number, key: string, note: string) {
    return this.scheduler.withLock(missionId, async () => {
      const { mission, task, plan } = await this.find(userId, missionId, key);
      if (task.status !== 'review' && task.status !== 'blocked') {
        throw new ConflictException('Il task non si può rifare in questo stato');
      }
      // Only while the mission waits on this task: a stopped or finished mission stays as it is.
      const wait = this.wait(mission);
      if (
        mission.status !== 'waiting' ||
        (wait?.code !== 'task_review' && wait?.code !== 'task_blocked') ||
        wait.taskId !== task.id
      ) {
        throw new ConflictException('La missione non aspetta questo task');
      }
      const project = await this.projects.get(userId, mission.projectId);
      const missionBranch =
        mission.branch ?? missionBranchName(missionId, plan.title);
      const tip = await this.git.revParse(
        project.path,
        `refs/heads/${missionBranch}`,
      );
      if (!tip) throw new ConflictException('La missione non ha un branch');

      const branch = task.branch ?? taskBranchName(missionId, task.key);
      const current = this.reportOf(task.reportJson);
      const diff = task.worktreePath
        ? await this.git
            .diffText(
              task.worktreePath,
              task.taskBase ?? tip,
              branch,
              this.config.missionTaskDiffKb() * 1024,
            )
            .catch(() => '')
        : '';
      const previous = {
        diff,
        review: current?.review
          ? `${current.review.verdict}: ${current.review.output}`
          : current?.blocked?.detail ?? '',
      };
      const report = {
        ...(current ?? {
          attempt: task.attempts,
          diff: { files: [], added: 0, removed: 0 },
          checks: [],
          review: null,
          iterations: 0,
          warnings: [],
          costUsd: 0,
          summary: '',
        }),
        previous,
        blocked: undefined,
      };
      const notes = this.notes(task.notesJson);
      notes.push(note);

      // The branch goes back to the mission's tip; the worktree is recreated if it's gone.
      const worktree =
        task.worktreePath ??
        taskWorktreePath(
          await this.config.resolvedDataDir(),
          mission.projectId,
          missionId,
          task.key,
        );
      try {
        const exists = await this.git.revParse(
          project.path,
          `refs/heads/${branch}`,
        );
        if (!exists) await this.git.createBranch(project.path, branch, tip);
        // resetTo moves the branch when the worktree already has it checked out.
        await this.git.addWorktree(project.path, worktree, branch);
        await this.git.resetTo(worktree, tip);
      } catch (error) {
        throw new ConflictException(
          `Il branch del task non torna alla punta della missione: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.missionTask.update({
          where: { id: task.id },
          data: {
            status: 'pending',
            attempts: { increment: 1 },
            notesJson: JSON.stringify(notes),
            reportJson: JSON.stringify(report),
            taskBase: tip,
            worktreePath: worktree,
            startedAt: null,
            finishedAt: null,
          },
        });
        await tx.mission.update({
          where: { id: missionId },
          data: { status: 'running', waitJson: null },
        });
        await tx.missionEntry.create({
          data: {
            missionId,
            taskId: task.id,
            kind: 'status',
            dataJson: JSON.stringify({
              status: 'pending',
              taskId: task.id,
              attempt: task.attempts + 1,
              note,
            }),
          },
        });
      });
      this.scheduler.wake(missionId);
      return this.missions.get(userId, missionId);
    });
  }

  /** Salta: the task is skipped and its dependents go on with a warning. */
  async skip(userId: number, missionId: number, key: string) {
    return this.scheduler.withLock(missionId, async () => {
      const { mission, task } = await this.find(userId, missionId, key);
      if (task.status !== 'blocked') {
        throw new ConflictException('Si salta solo un task bloccato');
      }
      const wait = this.wait(mission);
      if (mission.status !== 'waiting' || wait?.code !== 'task_blocked' || wait.taskId !== task.id) {
        throw new ConflictException('La missione non aspetta questo task');
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.missionTask.update({
          where: { id: task.id },
          data: { status: 'skipped', finishedAt: new Date() },
        });
        await tx.mission.update({
          where: { id: missionId },
          data: { status: 'running', waitJson: null },
        });
        await tx.missionEntry.create({
          data: {
            missionId,
            taskId: task.id,
            kind: 'status',
            dataJson: JSON.stringify({ status: 'skipped', taskId: task.id }),
          },
        });
      });
      this.scheduler.wake(missionId);
      return this.missions.get(userId, missionId);
    });
  }

  /** Riprova: the full checks of the mission again. */
  async retryFinalChecks(userId: number, missionId: number) {
    return this.scheduler.withLock(missionId, async () => {
      const mission = await this.prisma.mission.findFirst({
        where: { id: missionId, userId },
      });
      if (!mission) throw new NotFoundException('Missione non trovata');
      const wait = this.wait(mission);
      if (mission.status !== 'waiting' || wait?.code !== 'final_checks') {
        throw new ConflictException('La missione non aspetta i controlli finali');
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.mission.update({
          where: { id: missionId },
          data: { status: 'running', waitJson: null },
        });
        await tx.missionEntry.create({
          data: {
            missionId,
            kind: 'status',
            dataJson: JSON.stringify({ status: 'running', retry: 'final_checks' }),
          },
        });
      });
      this.scheduler.wake(missionId);
      return this.missions.get(userId, missionId);
    });
  }

  private reportOf(json: string | null) {
    if (!json) return null;
    try {
      return JSON.parse(json) as TaskReport & { previous?: unknown };
    } catch {
      return null;
    }
  }

  private withBlocked(
    task: { reportJson: string | null; attempts: number },
    reason: 'merge',
    detail: string,
  ): TaskReport {
    const current = this.reportOf(task.reportJson) ?? {
      attempt: task.attempts,
      diff: { files: [], added: 0, removed: 0 },
      checks: [],
      review: null,
      iterations: 0,
      warnings: [],
      costUsd: 0,
      summary: '',
    };
    return { ...current, blocked: { reason, detail } };
  }

  private notes(json: string): string[] {
    try {
      const value = JSON.parse(json) as unknown;
      return Array.isArray(value)
        ? value.filter((n): n is string => typeof n === 'string')
        : [];
    } catch {
      return [];
    }
  }

  /** Every worktree and branch of the mission's tasks, for a delete. */
  async clean(mission: {
    id: number;
    projectId: number;
    branch: string | null;
    title: string;
  }) {
    const project = await this.prisma.project.findUnique({
      where: { id: mission.projectId },
      select: { path: true },
    });
    if (!project) return;
    const tasks = await this.prisma.missionTask.findMany({
      where: { missionId: mission.id },
    });
    const dataDir = await this.config.resolvedDataDir();
    for (const task of tasks) {
      const worktree =
        task.worktreePath ??
        taskWorktreePath(dataDir, mission.projectId, mission.id, task.key);
      await this.git.removeWorktree(project.path, worktree).catch(() => undefined);
      await this.git
        .deleteBranch(
          project.path,
          task.branch ?? taskBranchName(mission.id, task.key),
        )
        .catch(() => undefined);
    }
  }
}

/** Kept for the API's type of a status the task can have. */
export const TASK_STATUSES = [
  'pending',
  'running',
  'review',
  'merging',
  'done',
  'blocked',
  'skipped',
  'aborted',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type { Plan };
