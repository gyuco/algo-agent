import { Injectable, type OnModuleInit } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Run } from '../generated/prisma/client.js';
import { RunConfig } from '../runs/run-config.js';
import { RunHandlers } from '../runs/run-handlers.js';
import type {
  PrepareStep,
  RunEventData,
  RunHandler,
  RunOutcome,
} from '../runs/run-types.js';
import { VaultService } from '../vault/vault.service.js';
import {
  ChecksService,
  type CheckEvent,
  type CheckName,
  type CheckRequest,
  type CheckResult,
} from './checks.service.js';
import { GitService } from './git-service.js';
import { missionBranchName, missionWorktreePath } from './mission-paths.js';
import { MissionScheduler } from './mission-scheduler.service.js';
import { MissionsService } from './missions.service.js';
import { planSchema, planTasks } from './plan-schema.js';

const BASE_CHECKS: CheckName[] = ['build', 'lint', 'test'];
const DETAIL_LINES = 5;
const DETAIL_LENGTH = 500;

/** A short, readable reason from a command's output, for the `baseline` wait. */
function detailOf(result: CheckResult) {
  const lines = result.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, DETAIL_LINES);
  const detail = lines.join('\n').slice(0, DETAIL_LENGTH);
  if (result.timedOut)
    return ['Timeout del comando', detail].filter(Boolean).join('\n');
  return detail || `Exit code ${result.exitCode ?? 'sconosciuto'}`;
}

/** Yields events pushed while `work` runs, so the output reaches the user live. */
async function* live(
  work: (push: (event: RunEventData) => void) => Promise<CheckResult[] | null>,
): AsyncGenerator<RunEventData, CheckResult[] | null> {
  const queue: RunEventData[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const push = (event: RunEventData) => {
    queue.push(event);
    wake?.();
  };
  const task = work(push).finally(() => {
    done = true;
    wake?.();
  });
  // Keep the rejection for the `await` below, not as an unhandled one.
  task.catch(() => undefined);

  for (;;) {
    while (queue.length) yield queue.shift()!;
    if (done) break;
    await new Promise<void>((resolve) => (wake = resolve));
  }
  return await task;
}

/** The preparation after an approval: branch, worktree, baseline checks, then `running`. */
@Injectable()
export class MissionPrepareHandler implements RunHandler, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly git: GitService,
    private readonly checks: ChecksService,
    private readonly config: RunConfig,
    private readonly vault: VaultService,
    private readonly missions: MissionsService,
    private readonly scheduler: MissionScheduler,
    private readonly handlers: RunHandlers,
  ) {}

  onModuleInit() {
    this.handlers.register('mission-prepare', this);
  }

  async *execute(
    run: Run,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, RunOutcome> {
    if (!run.missionId)
      throw new Error('La preparazione non appartiene a una missione');
    const mission = await this.prisma.mission.findUnique({
      where: { id: run.missionId },
      include: { project: { select: { id: true, path: true } } },
    });
    if (!mission) throw new Error('Missione non trovata');
    // An approval was revised, or the mission was stopped, meanwhile.
    if (mission.status !== 'approved') return 'done';

    const plan = mission.planJson
      ? planSchema.safeParse(JSON.parse(mission.planJson))
      : null;
    const baseBranch = mission.baseBranch;
    if (!plan?.success || !baseBranch) {
      await this.fail(
        run,
        signal,
        'branch',
        'Il piano approvato o il branch base non sono leggibili',
      );
      return 'done';
    }
    const approved = plan.data;

    // 1. fetch and branch
    yield this.step('fetch', 'started');
    const base = await this.git.baseRef(mission.project.path, baseBranch);
    if (base.warning) yield { type: 'error', message: base.warning };
    const baseCommit = base.ref
      ? await this.git.revParse(mission.project.path, base.ref)
      : null;
    if (!baseCommit) {
      yield this.step(
        'fetch',
        'failed',
        `Nessun branch "${baseBranch}" da cui partire`,
      );
      await this.fail(
        run,
        signal,
        'branch',
        `Il branch "${baseBranch}" non esiste in locale né su origin`,
      );
      return 'done';
    }
    yield this.step('fetch', 'done', base.warning);

    const branch =
      mission.branch ?? missionBranchName(mission.id, approved.title);
    yield this.step('branch', 'started', branch);
    try {
      const existing = await this.git.revParse(
        mission.project.path,
        `refs/heads/${branch}`,
      );
      if (!existing) {
        await this.git.createBranch(mission.project.path, branch, baseCommit);
      } else if (existing !== baseCommit) {
        const ahead = await this.git.aheadOfRef(
          mission.project.path,
          `refs/heads/${branch}`,
          baseCommit,
        );
        if (ahead > 0) {
          throw new Error(
            `Il branch ${branch} ha ${ahead} commit propri: non lo sposto`,
          );
        }
        await this.git.moveBranch(mission.project.path, branch, baseCommit);
      }
      await this.prisma.mission.update({
        where: { id: mission.id },
        data: { branch, baseCommit },
      });
      yield this.step('branch', 'done', branch);
    } catch (error) {
      const detail = message(error);
      yield this.step('branch', 'failed', detail);
      await this.fail(run, signal, 'branch', detail);
      return 'done';
    }

    // 2. worktree
    const dataDir = await this.config.resolvedDataDir();
    const worktree =
      mission.worktreePath ??
      missionWorktreePath(dataDir, mission.projectId, mission.id);
    yield this.step('worktree', 'started', worktree);
    try {
      await mkdir(dirname(worktree), { recursive: true });
      await this.git.addWorktree(mission.project.path, worktree, branch);
      await this.prisma.mission.update({
        where: { id: mission.id },
        data: { worktreePath: worktree },
      });
      yield this.step('worktree', 'done', worktree);
    } catch (error) {
      const detail = message(error);
      yield this.step('worktree', 'failed', detail);
      await this.fail(run, signal, 'worktree', detail);
      return 'done';
    }

    // 3. setup and baseline checks, in the sandbox
    const all = await this.vault.variables(mission.userId, mission.projectId);
    const secrets = Object.fromEntries(
      approved.checks.secrets
        .filter((name) => name in all)
        .map((name) => [name, all[name]]),
    );
    const request: CheckRequest = {
      runId: run.id,
      projectId: mission.projectId,
      worktree,
      plan: approved,
      names: [],
      secrets,
      signal,
      onEvent: () => undefined,
    };
    const event =
      (name: CheckName) =>
      (e: CheckEvent): RunEventData | null => {
        if (e.type === 'output')
          return { type: 'check_output', name, text: e.text };
        if (e.type === 'started')
          return { type: 'prepare_step', step: name, status: 'started' };
        return {
          type: 'prepare_step',
          step: name,
          status: e.ok ? 'done' : 'failed',
          detail: e.ok ? undefined : `Exit code ${e.exitCode ?? '?'}`,
        };
      };

    const setupResults = yield* live(async (push) => {
      const result = await this.checks.ensureSetup({
        ...request,
        names: ['setup'],
        onEvent: (e) => {
          const mapped = event('setup')(e);
          if (mapped) push(mapped);
        },
      });
      return result ? [result] : [];
    });
    const setup = setupResults?.[0] ?? null;
    if (setup && !setup.ok) {
      await this.fail(run, signal, 'setup', detailOf(setup), setup.output);
      return 'done';
    }
    // No events when the marker is fresh: say it here.
    if (!setup) yield this.step('setup', 'skipped');

    for (const name of BASE_CHECKS) {
      if (!approved.checks[name]) yield this.step(name, 'skipped');
    }
    const defined = BASE_CHECKS.filter((name) => approved.checks[name]);
    if (defined.length) {
      const results = yield* live((push) =>
        this.checks.run({
          ...request,
          names: defined,
          onEvent: (e) => {
            const mapped = event(e.name)(e);
            if (mapped) push(mapped);
          },
        }),
      );
      const failed = results?.find((r) => !r.ok);
      if (failed) {
        if (signal.aborted) return 'done';
        await this.fail(
          run,
          signal,
          failed.name,
          detailOf(failed),
          failed.output,
        );
        return 'done';
      }
    }
    if (signal.aborted) return 'done';

    // 4. ready, with the rows of the plan's tasks, in the same transaction
    const { count } = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.mission.updateMany({
        where: { id: mission.id, userId: mission.userId, status: 'approved' },
        data: { status: 'running', waitJson: null },
      });
      if (!moved.count) return moved;
      await tx.missionTask.createMany({
        data: planTasks(approved).map((task) => ({
          missionId: mission.id,
          key: task.key,
          milestone: task.milestone,
          status: 'pending',
        })),
      });
      return moved;
    });
    if (count) {
      await this.missions.record(mission.id, 'status', { status: 'running' });
      this.scheduler.wake(mission.id);
    }
    return 'done';
  }

  private step(
    step: PrepareStep,
    status: 'started' | 'done' | 'failed' | 'skipped',
    detail?: string,
  ): RunEventData {
    return {
      type: 'prepare_step',
      step,
      status,
      ...(detail ? { detail } : {}),
    };
  }

  /** Moves the mission to `waiting { baseline }` and records why. */
  private async fail(
    run: Run,
    signal: AbortSignal,
    step: PrepareStep,
    detail: string,
    output?: string,
  ) {
    // The user stopped the mission: leave its state to `abort`.
    if (!run.missionId || signal.aborted) return;
    const wait = { code: 'baseline', runId: run.id, step, detail };
    const { count } = await this.prisma.mission.updateMany({
      where: { id: run.missionId, status: 'approved' },
      data: { status: 'waiting', waitJson: JSON.stringify(wait) },
    });
    if (count) {
      await this.missions.record(
        run.missionId,
        'wait',
        { ...wait, ...(output ? { output } : {}) },
        { notify: true },
      );
    }
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
