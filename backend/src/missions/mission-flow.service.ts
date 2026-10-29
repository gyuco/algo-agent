import { Injectable, Logger } from '@nestjs/common';
import { AgentRunnerService } from '../agents/agent-runner.service.js';
import type { Mission } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RunQueueService } from '../runs/run-queue.service.js';
import { ACTIVE_STATUSES, type RunOutcome } from '../runs/run-types.js';
import { readProgress, writeProgress } from './mission-progress.js';
import { MissionsService, orchestratorAgent } from './missions.service.js';
import { finalMessage, milestoneMessage } from './orchestrator-prompt.js';
import { planSchema, planTasks } from './plan-schema.js';

export type ChecksPurpose = 'milestone' | 'final' | 'integration';
export type TurnPurpose = 'milestone' | 'revision' | 'final';

export interface CheckSummary {
  ok: boolean;
  results: { name: string; ok: boolean; exitCode: number | null; durationMs: number }[];
}

/** The steps between the scheduler and the runs: checks, review turns, milestone confirmations. */
@Injectable()
export class MissionFlowService {
  private readonly logger = new Logger(MissionFlowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: RunQueueService,
    private readonly runner: AgentRunnerService,
    private readonly missions: MissionsService,
  ) {}

  /** Queues the full checks of the mission's worktree for one purpose. */
  async queueChecks(
    mission: Mission,
    purpose: ChecksPurpose,
    extra: { milestone?: string; taskId?: number } = {},
  ) {
    if (!mission.worktreePath) return null;
    const run = await this.queue.enqueue({
      projectId: mission.projectId,
      userId: mission.userId,
      kind: 'mission-checks',
      title: `${mission.title} · checks ${purpose}`,
      input: JSON.stringify({ purpose, ...extra }),
      writes: false,
      missionId: mission.id,
    });
    await this.missions.record(mission.id, 'checks_started', {
      runId: run.id,
      purpose,
      ...extra,
    }, extra.taskId ? { taskId: extra.taskId } : {});
    return run;
  }

  /** Whether a checks run or a review turn of the mission is active now. */
  async busy(missionId: number) {
    const run = await this.prisma.run.findFirst({
      where: {
        missionId,
        kind: { in: ['mission-checks', 'mission-orchestrator', 'mission-integrate'] },
        status: { in: ACTIVE_STATUSES },
      },
      select: { id: true },
    });
    return Boolean(run);
  }

  /** Queues an orchestrator turn for its purpose; null when another turn is active. */
  async queueTurn(
    mission: Mission,
    purpose: TurnPurpose,
    input: string,
    options: { newSession?: boolean; milestone?: string; checksOk?: boolean } = {},
  ) {
    if (mission.projectId === null) return null;
    const active = await this.prisma.run.findFirst({
      where: {
        missionId: mission.id,
        kind: 'mission-orchestrator',
        status: { in: ACTIVE_STATUSES },
      },
      select: { id: true },
    });
    if (active) return null;
    const project = await this.prisma.project.findUnique({
      where: { id: mission.projectId },
      select: { id: true, path: true },
    });
    if (!project) return null;
    const { provider } = await this.runner.check({
      userId: mission.userId,
      project,
      agentSpec: orchestratorAgent(),
      model: mission.orchestratorModel,
    });
    const run = await this.queue.enqueue({
      projectId: mission.projectId,
      userId: mission.userId,
      kind: 'mission-orchestrator',
      title: mission.title,
      input,
      sessionId: options.newSession ? null : mission.sessionId,
      model: mission.orchestratorModel,
      provider,
      writes: false,
      missionId: mission.id,
      purposeJson: JSON.stringify({
        purpose,
        ...(options.milestone ? { milestone: options.milestone } : {}),
        ...(options.checksOk !== undefined ? { checksOk: options.checksOk } : {}),
      }),
    });
    await this.missions.record(mission.id, 'turn', { runId: run.id, purpose });
    return run;
  }

  /** §5.4: the checks of a closed milestone, then one review turn in a new session. */
  async reviewMilestone(
    missionId: number,
    milestone: string,
    checks: CheckSummary,
  ) {
    const mission = await this.prisma.mission.findUnique({
      where: { id: missionId },
    });
    if (!mission?.planJson || mission.status !== 'running') return;
    const plan = planSchema.safeParse(JSON.parse(mission.planJson));
    if (!plan.success) return;
    const rows = await this.prisma.missionTask.findMany({
      where: { missionId },
      orderBy: { id: 'asc' },
    });
    const closed = planTasks(plan.data).filter((task) => task.milestone === milestone);
    const decisions = await this.prisma.missionEntry.findMany({
      where: { missionId, kind: 'decision' },
      orderBy: { id: 'asc' },
      take: 50,
    });
    const index = plan.data.milestones.findIndex((m) => m.id === milestone);
    const input = milestoneMessage({
      milestoneId: milestone,
      milestoneTitle: plan.data.milestones[index]?.title ?? milestone,
      planVersion: mission.planVersion,
      tasks: closed.map((task) => {
        const row = rows.find((r) => r.key === task.key);
        const report = row?.reportJson
          ? (JSON.parse(row.reportJson) as {
              summary?: string;
              review?: { verdict?: string };
              warnings?: string[];
              costUsd?: number;
            })
          : null;
        return `- **${task.key}** ${task.title ?? ''}: ${row?.status ?? 'pending'}${
          report?.review?.verdict ? ` · verdict ${report.review.verdict}` : ''
        }${report?.warnings?.length ? ` · warnings: ${report.warnings.join('; ')}` : ''}${
          report?.costUsd ? ` · $${report.costUsd.toFixed(2)}` : ''
        }${report?.summary ? `\n  ${report.summary.split('\n')[0]}` : ''}`;
      }),
      checks: {
        ok: checks.ok,
        results: checks.results.map(
          (r) =>
            `- ${r.name}: ${r.ok ? 'ok' : 'failed'} (exit ${r.exitCode ?? '?'}, ${Math.round(r.durationMs / 1000)} s)`,
        ),
      },
      decisions: decisions.map((entry) => {
        const data = JSON.parse(entry.dataJson) as {
          question?: string;
          chosen?: string;
          reason?: string;
        };
        return `- ${data.question ?? '?'} → ${data.chosen ?? '?'}${data.reason ? `. ${data.reason}` : ''}`;
      }),
      nextMilestones: plan.data.milestones
        .slice(index + 1)
        .map((m) => `- ${m.id}: ${m.title ?? m.id}`),
      auto: mission.mode === 'auto',
    });
    // A new session reads the state, not the briefing's conversation (§8.3).
    await this.queueTurn(mission, 'milestone', input, {
      newSession: true,
      milestone,
      checksOk: checks.ok,
    });
  }

  /** §5.4: the milestone is confirmed, implicitly or explicitly. */
  async confirmMilestone(
    missionId: number,
    milestone: string,
    summary: string | null,
    implicit: boolean,
  ) {
    const mission = await this.prisma.mission.findUnique({
      where: { id: missionId },
    });
    if (!mission) return;
    const progress = readProgress(mission);
    if (!progress.reviewedMilestones.includes(milestone)) {
      progress.reviewedMilestones.push(milestone);
    }
    const { count } = await this.prisma.mission.updateMany({
      where: { id: missionId, progressJson: mission.progressJson },
      data: { progressJson: writeProgress(progress), waitJson: null },
    });
    if (!count) return;
    await this.missions.record(missionId, 'milestone', {
      id: milestone,
      summary: summary ?? 'Confermata senza modifiche',
      implicit,
    });
  }

  /** §6.3: the final checks passed; the mission publishes its branch. */
  async finalOk(missionId: number) {
    const mission = await this.prisma.mission.findUnique({
      where: { id: missionId },
    });
    if (!mission) return;
    const { count } = await this.prisma.mission.updateMany({
      where: { id: missionId, status: 'running' },
      data: { status: 'integrating', waitJson: null },
    });
    if (!count) return;
    await this.missions.record(missionId, 'status', { status: 'integrating' });
    await this.queuePublish(mission);
  }

  /** Queues one `mission-publish`, unless one is active. */
  async queuePublish(mission: Mission) {
    const active = await this.prisma.run.findFirst({
      where: {
        missionId: mission.id,
        kind: 'mission-publish',
        status: { in: ACTIVE_STATUSES },
      },
      select: { id: true },
    });
    if (active) return null;
    return this.queue.enqueue({
      projectId: mission.projectId,
      userId: mission.userId,
      kind: 'mission-publish',
      title: mission.title,
      input: '',
      writes: false,
      missionId: mission.id,
    });
  }

  /** Red final checks: automatic mode asks the orchestrator, step mode waits. */
  async finalFailed(missionId: number, failures: string[]) {
    const mission = await this.prisma.mission.findUnique({
      where: { id: missionId },
    });
    if (!mission) return;
    if (mission.mode === 'auto') {
      await this.queueTurn(mission, 'final', finalMessage(failures));
      return;
    }
    const wait = { code: 'final_checks', detail: failures.join('\n') };
    const { count } = await this.prisma.mission.updateMany({
      where: { id: missionId, status: 'running' },
      data: { status: 'waiting', waitJson: JSON.stringify(wait) },
    });
    if (!count) return;
    await this.missions.record(missionId, 'wait', wait, { notify: true });
  }

  /** Applies checks in automatic mode: a failing milestone without a fix waits for the user. */
  async milestoneUnfixed(missionId: number, milestone: string, detail: string) {
    const wait = { code: 'milestone', milestone, detail };
    const { count } = await this.prisma.mission.updateMany({
      where: { id: missionId, status: 'running' },
      data: { status: 'waiting', waitJson: JSON.stringify(wait) },
    });
    if (!count) return;
    await this.missions.record(missionId, 'wait', wait, { notify: true });
  }

  /** The end of a turn: a milestone turn without a closing tool is a confirmation. */
  async afterTurn(
    missionId: number,
    purpose: TurnPurpose,
    outcome: RunOutcome,
    turn: { closed: boolean },
    options: { milestone?: string; checksOk?: boolean } = {},
  ) {
    const mission = await this.prisma.mission.findUnique({
      where: { id: missionId },
    });
    if (!mission || mission.status === 'aborted') return;
    // A failed review turn waits for the user: otherwise the scheduler would
    // queue the same turn again on every pass.
    if (outcome === 'failed' && purpose !== 'revision') {
      await this.milestoneUnfixed(
        missionId,
        purpose === 'milestone' ? (options.milestone ?? 'final') : 'final',
        "Il turno dell'orchestratore non è riuscito",
      );
      return;
    }
    if (purpose === 'milestone') {
      if (!turn.closed && options.milestone) {
        await this.confirmMilestone(missionId, options.milestone, null, true);
      }
      if (options.checksOk === false && options.milestone) {
        const open = await this.prisma.missionTask.count({
          where: {
            missionId,
            milestone: options.milestone,
            status: { notIn: ['done', 'skipped'] },
          },
        });
        if (!open) {
          await this.milestoneUnfixed(
            missionId,
            options.milestone,
            'I controlli della milestone sono rossi e il turno non ha aggiunto un task correttivo',
          );
        }
      }
      return;
    }
    if (purpose === 'revision' && !turn.closed) {
      // No update_plan: back to the wait that started the revision.
      const wait = mission.waitJson
        ? (JSON.parse(mission.waitJson) as {
            code?: string;
            previous?: { code?: string };
          })
        : null;
      // Only from the revision wait: an approval in the meantime wins.
      if (mission.status !== 'waiting' || wait?.code !== 'revision') return;
      const next = wait.previous ?? { code: 'task_blocked' };
      const { count } = await this.prisma.mission.updateMany({
        where: { id: missionId, status: 'waiting', waitJson: mission.waitJson },
        data: { waitJson: JSON.stringify(next) },
      });
      if (count) await this.missions.record(missionId, 'wait', next, { notify: true });
      return;
    }
    if (purpose === 'final') {
      // The turn may have added corrective tasks; otherwise the mission waits.
      const tasks = await this.prisma.missionTask.count({
        where: { missionId, status: { in: ['pending', 'running', 'ready', 'merging'] } },
      });
      if (!tasks) {
        await this.milestoneUnfixed(
          missionId,
          'final',
          'I controlli finali restano rossi senza task correttivi',
        );
      }
    }
  }
}
