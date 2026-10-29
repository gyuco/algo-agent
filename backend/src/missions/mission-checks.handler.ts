import { Injectable, type OnModuleInit } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import type { Mission, MissionTask, Run } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RunHandlers } from '../runs/run-handlers.js';
import type {
  RunEventData,
  RunHandler,
  RunOutcome,
} from '../runs/run-types.js';
import { VaultService } from '../vault/vault.service.js';
import {
  ChecksService,
  CHECK_NAMES,
  type CheckResult,
} from './checks.service.js';
import { GitService } from './git-service.js';
import { MissionFlowService, type ChecksPurpose } from './mission-flow.service.js';
import { MissionsService } from './missions.service.js';
import { planSchema, type Plan } from './plan-schema.js';
import { ScopeService, type ScopeViolation } from './scope.service.js';
import type { TaskReport } from './mission-task.handler.js';

interface ChecksInput {
  purpose: ChecksPurpose;
  milestone?: string;
  taskId?: number;
}

const DETAIL_LINES = 5;
const DETAIL_LENGTH = 500;

function detailOf(result: CheckResult) {
  const detail = result.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, DETAIL_LINES)
    .join('\n')
    .slice(0, DETAIL_LENGTH);
  if (result.timedOut)
    return ['Timeout del comando', detail].filter(Boolean).join('\n');
  return detail || `Exit code ${result.exitCode ?? 'sconosciuto'}`;
}

function violationsText(violations: ScopeViolation[]) {
  return violations
    .map((v) => {
      if (v.kind === 'dependency')
        return `- ${v.file}: nuova dipendenza "${v.name}"`;
      if (v.kind === 'migration') return `- ${v.file}: migrazione non consentita`;
      if (v.kind === 'deleted') return `- ${v.file}: file cancellato`;
      return `- ${v.file}: fuori da scope.paths`;
    })
    .join('\n');
}

/** The full checks of the mission's worktree, out of the scheduler's lock (debt 0.5). */
@Injectable()
export class MissionChecksHandler implements RunHandler, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly git: GitService,
    private readonly checks: ChecksService,
    private readonly scope: ScopeService,
    private readonly vault: VaultService,
    private readonly flow: MissionFlowService,
    private readonly missions: MissionsService,
    private readonly handlers: RunHandlers,
  ) {}

  onModuleInit() {
    this.handlers.register('mission-checks', this);
  }

  async *execute(
    run: Run,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, RunOutcome> {
    if (!run.missionId) throw new Error('Il run non appartiene a una missione');
    const input = JSON.parse(run.input || '{}') as ChecksInput;
    const mission = await this.prisma.mission.findUnique({
      where: { id: run.missionId },
    });
    if (!mission) throw new Error('Missione non trovata');
    if (mission.status !== 'running' || !mission.worktreePath) return 'done';
    const plan = mission.planJson
      ? planSchema.safeParse(JSON.parse(mission.planJson))
      : null;
    if (!plan?.success) return 'done';

    const task = input.taskId
      ? await this.prisma.missionTask.findUnique({
          where: { id: input.taskId },
        })
      : null;

    // §5.3: the integrator's work is checked before the merge commit.
    if (input.purpose === 'integration') {
      if (!task || task.status !== 'merging') return 'done';
      const violations = await this.taskViolations(mission, task, plan.data);
      if (violations.length) {
        await this.git.abortMerge(mission.worktreePath);
        await this.blockIntegration(
          mission,
          task,
          `Perimetro violato:\n${violationsText(violations)}`,
        );
        return 'done';
      }
    }

    const all = await this.vault.variables(mission.userId, mission.projectId!);
    const secrets = Object.fromEntries(
      plan.data.checks.secrets
        .filter((name) => name in all)
        .map((name) => [name, all[name]]),
    );
    const names = CHECK_NAMES.filter(
      (name) => name === 'test' || plan.data.checks[name],
    );

    const events: RunEventData[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const running = this.checks
      .run({
        runId: run.id,
        projectId: mission.projectId!,
        worktree: mission.worktreePath,
        plan: plan.data,
        names: [...names],
        secrets,
        signal,
        onEvent: (event) => {
          if (event.type === 'output') {
            events.push({
              type: 'check_output',
              name: event.name,
              text: event.text,
            });
            wake?.();
          }
        },
      })
      .finally(() => {
        finished = true;
        wake?.();
      });
    running.catch(() => undefined);
    for (;;) {
      while (events.length) yield events.shift()!;
      if (finished) break;
      await new Promise<void>((resolve) => (wake = resolve));
    }

    let results: CheckResult[];
    try {
      results = await running;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted) return 'done';
      if (input.purpose === 'integration') {
        await this.git.abortMerge(mission.worktreePath);
        if (task) await this.blockIntegration(mission, task, message);
        return 'done';
      }
      await this.flow.milestoneUnfixed(
        mission.id,
        input.milestone ?? 'final',
        message,
      );
      return 'done';
    }
    if (signal.aborted) {
      if (input.purpose === 'integration') {
        await this.git.abortMerge(mission.worktreePath);
      }
      return 'done';
    }

    const ok = results.every((result) => result.ok);
    const failed = results.find((result) => !result.ok);
    const summary = {
      ok,
      results: results.map((result) => ({
        name: result.name,
        ok: result.ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      })),
    };
    await this.missions.record(
      mission.id,
      'checks',
      {
        purpose: input.purpose,
        ...(input.milestone ? { milestone: input.milestone } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ok,
        results: summary.results,
        ...(failed ? { detail: detailOf(failed) } : {}),
      },
      input.taskId ? { taskId: input.taskId } : {},
    );

    if (input.purpose === 'integration' && task) {
      if (ok) {
        await this.commitIntegration(mission, task);
      } else {
        // §5.3: red checks leave the mission's worktree as it was before the merge.
        await this.git.abortMerge(mission.worktreePath);
        await this.blockIntegration(
          mission,
          task,
          failed ? detailOf(failed) : 'Controlli rossi',
        );
      }
      return 'done';
    }
    if (input.purpose === 'milestone' && input.milestone) {
      await this.flow.reviewMilestone(mission.id, input.milestone, summary);
      return 'done';
    }
    if (input.purpose === 'final') {
      if (ok) await this.flow.finalOk(mission.id);
      else {
        await this.flow.finalFailed(
          mission.id,
          results
            .filter((result) => !result.ok)
            .map((result) => `${result.name}: ${detailOf(result)}`),
        );
      }
    }
    return 'done';
  }

  /** The files the task touched, checked against the plan's perimeter. */
  private async taskViolations(mission: Mission, task: MissionTask, plan: Plan) {
    if (!mission.worktreePath || !task.taskBase || !task.branch) return [];
    const project = await this.prisma.project.findUnique({
      where: { id: mission.projectId! },
      select: { path: true },
    });
    if (!project) return [];
    const files = await this.git
      .changedBetween(project.path, task.taskBase, task.branch)
      .catch(() => []);
    return this.scope.check(
      mission.worktreePath,
      task.taskBase,
      plan.scope,
      files,
    );
  }

  /** §5.3: merge commit, task done, its worktree removed. */
  private async commitIntegration(mission: Mission, task: MissionTask) {
    if (!mission.worktreePath) return;
    await this.git.stageAll(mission.worktreePath);
    await this.git.continueMerge(mission.worktreePath);
    const project = await this.prisma.project.findUnique({
      where: { id: mission.projectId! },
      select: { path: true },
    });
    if (task.worktreePath && project) {
      await this.git
        .removeWorktree(project.path, task.worktreePath)
        .catch(() => undefined);
      await rm(task.worktreePath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    const { count } = await this.prisma.missionTask.updateMany({
      where: { id: task.id, status: 'merging' },
      data: { status: 'done', finishedAt: new Date(), worktreePath: null },
    });
    if (!count) return;
    await this.missions.record(
      mission.id,
      'status',
      { status: 'done', taskId: task.id, integrated: true },
      { taskId: task.id },
    );
  }

  /** The integration failed: the merge is aborted and the task blocked on `merge`. */
  private async blockIntegration(
    mission: Mission,
    task: MissionTask,
    detail: string,
  ) {
    const current = task.reportJson
      ? (JSON.parse(task.reportJson) as TaskReport)
      : null;
    const report: TaskReport = {
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
      blocked: { reason: 'merge', detail },
    };
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.missionTask.updateMany({
        where: { id: task.id, status: 'merging' },
        data: { status: 'blocked', finishedAt: now, reportJson: JSON.stringify(report) },
      });
      if (!moved.count) return;
      await tx.missionEntry.create({
        data: {
          missionId: mission.id,
          taskId: task.id,
          kind: 'status',
          dataJson: JSON.stringify({
            status: 'blocked',
            taskId: task.id,
            reason: 'merge',
            detail,
          }),
        },
      });
    });
  }
}
