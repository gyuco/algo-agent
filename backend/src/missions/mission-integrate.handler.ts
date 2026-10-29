import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AgentRunnerService } from '../agents/agent-runner.service.js';
import { ProjectResourcesService } from '../agents/project-resources.service.js';
import type { AgentSpec } from '../catalog/catalog.js';
import { CatalogService } from '../catalog/catalog.service.js';
import type { Mission, MissionTask, Run } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RunHandlers } from '../runs/run-handlers.js';
import type {
  RunEventData,
  RunHandler,
  RunOutcome,
} from '../runs/run-types.js';
import { GitService } from './git-service.js';
import { MissionFlowService } from './mission-flow.service.js';
import { MissionsService } from './missions.service.js';
import { MissionTools } from './mission-tools.js';
import { planSchema, planTasks, type Plan } from './plan-schema.js';
import type { TaskReport } from './mission-task.handler.js';

/** The integrator resolves a merge conflict in the mission's worktree, then the checks decide. */
@Injectable()
export class MissionIntegrateHandler implements RunHandler, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly runner: AgentRunnerService,
    private readonly catalogService: CatalogService,
    private readonly resources: ProjectResourcesService,
    private readonly git: GitService,
    private readonly tools: MissionTools,
    private readonly flow: MissionFlowService,
    private readonly missions: MissionsService,
    private readonly handlers: RunHandlers,
  ) {}

  onModuleInit() {
    this.handlers.register('mission-integrate', this);
  }

  async *execute(
    run: Run,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, RunOutcome> {
    if (!run.missionId) throw new Error('Il run non appartiene a una missione');
    const input = JSON.parse(run.input || '{}') as { taskId?: number };
    const mission = await this.prisma.mission.findUnique({
      where: { id: run.missionId },
    });
    const task = input.taskId
      ? await this.prisma.missionTask.findUnique({ where: { id: input.taskId } })
      : null;
    if (!mission?.worktreePath || !task || task.status !== 'merging') {
      return 'done';
    }
    const plan = mission.planJson
      ? planSchema.safeParse(JSON.parse(mission.planJson))
      : null;
    if (!plan?.success) return 'done';

    const conflicts = await this.git.conflicts(mission.worktreePath);
    const agent = await this.integrator(mission, task, plan.data, run);
    if (!agent) {
      await this.fail(mission, task, 'Ruolo integrator o agente non disponibile');
      return 'done';
    }
    const project = await this.projects.get(run.userId, mission.projectId!);
    const catalog = await this.catalogService.forProject(
      run.userId,
      mission.projectId!,
    );
    const enabled = await this.resources.isEnabled(mission.projectId!, catalog);
    if (
      catalog.agents.has(agent.key) &&
      !enabled('agent', agent.key)
    ) {
      await this.fail(mission, task, `L'agente ${agent.key} è disattivato`);
      return 'done';
    }
    try {
      await this.runner.check({
        userId: run.userId,
        project,
        agentSpec: agent,
      });
    } catch (error) {
      await this.fail(
        mission,
        task,
        error instanceof Error ? error.message : String(error),
      );
      return 'done';
    }

    const taskDiff = task.taskBase
      ? await this.git
          .diffText(mission.worktreePath, task.taskBase, task.branch ?? undefined, 20 * 1024)
          .catch(() => '')
      : '';
    const missionDiff = task.taskBase
      ? await this.git
          .diffText(mission.worktreePath, task.taskBase, 'HEAD', 20 * 1024)
          .catch(() => '')
      : '';
    const prompt = [
      '## Merge conflict in the mission branch',
      `Resolve the conflicts of the merge of task ${task.key} in the current working directory.`,
      'Change only what the conflict needs: do not improve or refactor anything else.',
      'Leave no conflict markers behind.',
      '',
      '## Conflicted files',
      ...conflicts.map((file) => `- ${file}`),
      '',
      '## The task branch diff',
      '```diff',
      taskDiff,
      '```',
      '',
      '## The mission branch since the task started',
      '```diff',
      missionDiff,
      '```',
      '',
      '## Acceptance criteria of the task',
      ...(
        planTasks(plan.data).find((t) => t.key === task.key)?.acceptance ?? []
      ).map((criterion) => `- ${criterion}`),
      '',
      '## Acceptance criteria of the tasks merged after it',
      ...(await this.laterCriteria(mission, task, plan.data)).map(
        (line) => `- ${line}`,
      ),
    ].join('\n');

    const answer = { failed: false, output: '' };
    for await (const event of this.runner.run({
      userId: run.userId,
      project,
      agentSpec: agent,
      prompt: { text: prompt, attachments: [] },
      cwd: mission.worktreePath,
      appTools: this.tools.taskTools({
        missionId: mission.id,
        runId: run.id,
        taskId: task.id,
        userId: run.userId,
        projectId: mission.projectId!,
        worktree: mission.worktreePath,
        taskBase: task.taskBase ?? mission.baseCommit ?? '',
        plan: plan.data,
        signal,
      }),
      toolContext: {
        cwd: mission.worktreePath,
        mission: {
          missionId: mission.id,
          runId: run.id,
          taskId: task.id,
          worktree: mission.worktreePath,
          taskBase: task.taskBase ?? '',
        },
      },
      signal,
    })) {
      if (event.type === 'text') answer.output += event.text;
      if (event.type === 'error') answer.failed = true;
      if (event.type === 'done' && event.isError) answer.failed = true;
      yield event;
    }
    if (signal.aborted) {
      await this.git.abortMerge(mission.worktreePath);
      return 'done';
    }
    if (answer.failed) {
      await this.fail(mission, task, 'L\'integratore non ha concluso');
      return 'done';
    }

    const marked = await this.git.conflictMarkers(mission.worktreePath, conflicts);
    if (marked.length) {
      await this.fail(
        mission,
        task,
        `Marcatori di conflitto rimasti:\n${marked.map((f) => `- ${f}`).join('\n')}`,
      );
      return 'done';
    }
    await this.git.stageAll(mission.worktreePath);
    const left = await this.git.conflicts(mission.worktreePath);
    if (left.length) {
      await this.fail(
        mission,
        task,
        `Conflitti non risolti:\n${left.map((f) => `- ${f}`).join('\n')}`,
      );
      return 'done';
    }

    await this.missions.record(
      mission.id,
      'note',
      { text: `Conflitto di ${task.key} risolto dall'integratore`, runId: run.id },
      { taskId: task.id },
    );
    await this.flow.queueChecks(mission, 'integration', { taskId: task.id });
    return 'done';
  }

  /** The integrator of the plan, or a custom agent the task assigned to the role. */
  private async integrator(
    mission: Mission,
    task: MissionTask,
    plan: Plan,
    run: Run,
  ): Promise<AgentSpec | null> {
    const planned = planTasks(plan).find((t) => t.key === task.key);
    const customKey = planned?.agents.integrator;
    const custom = customKey
      ? plan.team.custom.find((c) => c.key === customKey)
      : undefined;
    if (custom) {
      return {
        key: custom.key,
        description: custom.description,
        enabledByDefault: true,
        maxTurns: 80,
        permissions: {
          files: custom.permissions.files,
          skills: custom.permissions.skills,
          tools: [],
          mcp: [],
        },
        prompt: custom.prompt,
        model: custom.model,
      };
    }
    const role = plan.team.roles.integrator;
    if (!role) return null;
    const catalog = await this.catalogService.forProject(
      run.userId,
      mission.projectId!,
    );
    const base = catalog.agents.get(role.agent);
    if (!base) return null;
    return { ...base, model: role.model, maxTurns: role.maxTurns };
  }

  /** The acceptance criteria of the tasks merged after this one started. */
  private async laterCriteria(mission: Mission, task: MissionTask, plan: Plan) {
    const rows = await this.prisma.missionTask.findMany({
      where: {
        missionId: mission.id,
        id: { not: task.id },
        status: 'done',
        finishedAt: { gt: task.startedAt ?? task.finishedAt ?? new Date(0) },
      },
      select: { key: true, finishedAt: true },
    });
    const tasks = new Map(planTasks(plan).map((t) => [t.key, t]));
    return rows.flatMap((row) => {
      const planned = tasks.get(row.key);
      return (planned?.acceptance ?? []).map(
        (criterion) => `${row.key}: ${criterion}`,
      );
    });
  }

  private async fail(mission: Mission, task: MissionTask, detail: string) {
    if (mission.worktreePath) await this.git.abortMerge(mission.worktreePath);
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
    const moved = await this.prisma.missionTask.updateMany({
      where: { id: task.id, status: 'merging' },
      data: {
        status: 'blocked',
        finishedAt: new Date(),
        reportJson: JSON.stringify(report),
      },
    });
    if (!moved.count) return;
    await this.missions.record(
      mission.id,
      'status',
      { status: 'blocked', taskId: task.id, reason: 'merge', detail },
      { taskId: task.id },
    );
  }
}
