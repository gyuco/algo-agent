import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AgentRunnerService } from '../agents/agent-runner.service.js';
import { ProjectResourcesService } from '../agents/project-resources.service.js';
import type { AgentSpec } from '../catalog/catalog.js';
import { CatalogService } from '../catalog/catalog.service.js';
import type { GraphStep } from '../catalog/workflow-graph.js';
import type { Mission, MissionTask, Run } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import {
  runGraph,
  type Answer,
  type CommandOutcome,
  type StepPort,
} from '../runs/graph-engine.js';
import { RunHandlers } from '../runs/run-handlers.js';
import { readSteps, type StepResults } from '../runs/run-steps.js';
import { RunQueueService } from '../runs/run-queue.service.js';
import type {
  RunEventData,
  RunHandler,
  RunOutcome,
} from '../runs/run-types.js';
import { VaultService } from '../vault/vault.service.js';
import {
  ChecksService,
  type CheckEvent,
  type CheckName,
  type CheckResult,
} from './checks.service.js';
import { GitService } from './git-service.js';
import { MissionTools } from './mission-tools.js';
import { planSchema, planTasks, type Plan } from './plan-schema.js';
import { ScopeService, type ScopeViolation } from './scope.service.js';
import {
  checkpoint,
  protectedFiles,
  squash as squashCheckpoints,
} from './task-checkpoints.js';
import type { ResolvedAgent, TaskGraph } from './task-graph.factory.js';

const SUMMARY_LINES = 5;
const SUMMARY_LENGTH = 800;

/** Why a task stopped being runnable. */
export type BlockedReason =
  | 'attempts'
  | 'test_errati'
  | 'error'
  | 'config'
  | 'merge';

export interface TaskReport {
  attempt: number;
  diff: {
    files: { path: string; status: string; added: number; removed: number }[];
    added: number;
    removed: number;
  };
  checks: unknown[];
  review: { verdict: string; output: string } | null;
  iterations: number;
  warnings: string[];
  costUsd: number;
  blocked?: { reason: BlockedReason; detail: string };
  summary: string;
}

/** What the API shows of a task without the whole report. */
function parsedReport(json: string | null) {
  if (!json) return null;
  try {
    return JSON.parse(json) as TaskReport & { previous?: unknown };
  } catch {
    return null;
  }
}

export function taskView(
  task: MissionTask,
  plan: Plan,
  waitingOn: string[],
) {
  const report = parsedReport(task.reportJson);
  const summary = taskSummary(task, plan);
  return {
    id: task.id,
    key: task.key,
    milestone: summary.milestone,
    title: summary.title,
    status: task.status,
    attempts: task.attempts,
    runId: task.runId,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    report: report ? { ...report, diff: undefined } : null,
    waitingOn,
  };
}

/** `{{mission-task}}` text pieces and the task's place in the plan. */
export function taskSummary(
  task: MissionTask,
  plan: Plan,
): {
  key: string;
  title: string;
  milestone: string;
  titleText: string;
} {
  for (const milestone of plan.milestones) {
    const found = milestone.tasks.find((t) => t.key === task.key);
    if (found) {
      return {
        key: task.key,
        title: found.title ?? task.key,
        milestone: milestone.id,
        titleText: milestone.title ?? milestone.id,
      };
    }
  }
  return {
    key: task.key,
    title: task.key,
    milestone: task.milestone,
    titleText: task.milestone,
  };
}

/** A short, readable text from a step's output. */
function summaryOf(steps: Record<string, { output: string }>) {
  const text = Object.values(steps)
    .map((s) => s.output)
    .join('\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, SUMMARY_LINES)
    .join('\n');
  return text.slice(0, SUMMARY_LENGTH);
}

function violationsText(violations: ScopeViolation[]) {
  return violations
    .map((v) => {
      if (v.kind === 'dependency') {
        return `- ${v.file}: nuova dipendenza "${v.name}" fuori da scope.dependencies`;
      }
      if (v.kind === 'migration') {
        return `- ${v.file}: migrazione non consentita`;
      }
      if (v.kind === 'deleted') return `- ${v.file}: file cancellato`;
      return `- ${v.file}: fuori da scope.paths`;
    })
    .join('\n');
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** The run of one task: its frozen graph, its worktree, checkpoints and report. */
@Injectable()
export class MissionTaskHandler implements RunHandler, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly runner: AgentRunnerService,
    private readonly catalogService: CatalogService,
    private readonly resources: ProjectResourcesService,
    private readonly checks: ChecksService,
    private readonly scope: ScopeService,
    private readonly git: GitService,
    private readonly vault: VaultService,
    private readonly tools: MissionTools,
    private readonly queue: RunQueueService,
    private readonly handlers: RunHandlers,
  ) {}

  onModuleInit() {
    this.handlers.register('mission-task', this);
  }

  async *execute(
    run: Run,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, RunOutcome> {
    if (!run.missionId || !run.missionTaskId) {
      throw new Error('Il run non appartiene a un task');
    }
    const mission = await this.prisma.mission.findUnique({
      where: { id: run.missionId },
    });
    const task = await this.prisma.missionTask.findUnique({
      where: { id: run.missionTaskId },
    });
    if (!mission || !task) throw new Error('Missione o task non trovati');
    // The mission was stopped or revised: nothing to do.
    if (mission.status !== 'running') return 'done';
    if (!task.worktreePath || !task.taskBase) {
      await this.close(run, task, mission, {
        reason: 'error',
        detail: 'Il worktree o il punto di partenza del task mancano',
      });
      return 'done';
    }

    const graph = this.graphOf(run);
    const plan = mission.planJson
      ? planSchema.safeParse(JSON.parse(mission.planJson))
      : null;
    if (!graph || !plan?.success) {
      await this.close(run, task, mission, {
        reason: 'config',
        detail: 'Il grafo del task o il piano non sono più leggibili',
      });
      return 'done';
    }

    const project = await this.projects.get(run.userId, mission.projectId);
    const catalog = await this.catalogService.forProject(
      run.userId,
      mission.projectId,
    );
    const enabled = await this.resources.isEnabled(mission.projectId, catalog);
    const missing = Object.values(graph.agents)
      .filter((a) => catalog.agents.has(a.spec.key) && !enabled('agent', a.spec.key))
      .map((a) => `L'agente ${a.spec.key} è disattivato nel progetto`);
    if (missing.length) {
      await this.close(run, task, mission, {
        reason: 'config',
        detail: missing.join('\n'),
      });
      return 'done';
    }

    const worktree = task.worktreePath;
    const taskBase = task.taskBase;
    const materialized = Object.entries(graph.agents) as [string, ResolvedAgent][];
    const byStep = new Map(materialized);
    const steps: StepResults = readSteps(run.stepsJson);
    // A step left running by a crash goes back to pending: its work is not in a checkpoint.
    for (const result of Object.values(steps)) {
      if (result.status === 'running' || result.status === 'waiting_approval') {
        result.status = 'pending';
        result.finishedAt = null;
      }
    }

    const all = await this.vault.variables(run.userId, mission.projectId);
    const secrets = Object.fromEntries(
      plan.data.checks.secrets
        .filter((name) => name in all)
        .map((name) => [name, all[name]]),
    );
    const iterations = new Map<string, number>();

    // `setup` runs once per task worktree, inside the run: it can be stopped and shows its output.
    const setup = yield* this.streamChecks((onEvent) =>
      this.checks
        .ensureSetup({
          runId: run.id,
          projectId: run.projectId,
          worktree,
          plan: plan.data,
          names: ['setup'],
          secrets,
          signal,
          onEvent,
        })
        .then((result) => (result ? [result] : [])),
    );
    if (signal.aborted) return 'done';
    if (setup instanceof Error || setup.some((r) => !r.ok)) {
      const failed = setup instanceof Error ? null : setup.find((r) => !r.ok);
      await this.close(run, task, mission, {
        reason: 'error',
        detail: failed
          ? `setup non riuscito:\n${failed.output.split('\n').filter(Boolean).slice(-SUMMARY_LINES).join('\n')}`
          : `setup non riuscito: ${message(setup)}`,
      });
      return 'done';
    }

    const port: StepPort = {
      invoke: (
        step: GraphStep,
        text: string,
        sessionId?: string,
      ): AsyncGenerator<RunEventData, Answer> =>
        this.invoke(
          run,
          project,
          worktree,
          task,
          plan.data,
          byStep.get(step.id)?.spec,
          byStep.get(step.id)?.tools ?? [],
          text,
          sessionId,
          signal,
        ),
      runCommands: (step: GraphStep) =>
        this.runCommands(step, run, plan.data, worktree, taskBase, secrets, signal),
      beforeCheck: async (check, writer, push) => {
        const output = await this.protect(
          check,
          writer,
          worktree,
          taskBase,
          steps,
          plan.data,
          push,
        );
        const violations = await this.scope.check(
          worktree,
          taskBase,
          plan.data.scope,
        );
        if (violations.length) {
          push({ type: 'scope_violation', id: check.id, violations });
        }
        const parts = [output, violations.length ? violationsText(violations) : null]
          .filter((p): p is string => Boolean(p));
        return parts.length ? parts.join('\n') : null;
      },
      afterWrite: async (step) => {
        const round = (iterations.get(step.id) ?? 0) + 1;
        iterations.set(step.id, round);
        return checkpoint(this.git, worktree, step.id, round);
      },
      mayStart: async () => true,
    };

    let outcome: RunOutcome;
    try {
      outcome = yield* runGraph({
        run,
        input: run.input,
        order: graph.steps,
        steps,
        signal,
        save: () =>
          this.prisma.run.update({
            where: { id: run.id },
            data: { stepsJson: JSON.stringify(steps) },
          }),
        port,
      });
    } catch (error) {
      if (signal.aborted) return 'done';
      await this.close(run, task, mission, {
        reason: 'error',
        detail: message(error),
      });
      return 'done';
    }
    if (signal.aborted) {
      await this.prisma.missionTask.updateMany({
        where: { id: task.id, status: 'running' },
        data: { status: 'aborted', finishedAt: new Date() },
      });
      return 'done';
    }
    // The mission was stopped while the engine ran.
    const current = await this.prisma.mission.findUnique({
      where: { id: mission.id },
      select: { status: true },
    });
    if (current?.status !== 'running') return 'done';

    await this.finish(run, task, mission, plan.data, graph, steps, outcome);
    return 'done';
  }

  private graphOf(run: Run): TaskGraph | null {
    if (!run.specJson) return null;
    try {
      const graph = JSON.parse(run.specJson) as TaskGraph;
      return Array.isArray(graph.steps) && graph.result ? graph : null;
    } catch {
      return null;
    }
  }

  private async *invoke(
    run: Run,
    project: { id: number; path: string },
    worktree: string,
    task: MissionTask,
    plan: Plan,
    agent: AgentSpec | undefined,
    tools: ('run_checks')[],
    text: string,
    sessionId: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, Answer> {
    if (!agent) {
      return { output: '', costUsd: 0, failed: true };
    }
    const answer: Answer = { output: '', costUsd: 0, failed: false };
    for await (const event of this.runner.run({
      userId: run.userId,
      project,
      agentSpec: agent,
      prompt: { text, attachments: [] },
      sessionId,
      cwd: worktree,
      appTools: tools.includes('run_checks')
        ? this.tools.taskTools({
            missionId: run.missionId!,
            runId: run.id,
            taskId: task.id,
            userId: run.userId,
            projectId: project.id,
            worktree,
            taskBase: task.taskBase!,
            plan,
            signal,
          })
        : [],
      toolContext: {
        cwd: worktree,
        mission: {
          missionId: run.missionId!,
          runId: run.id,
          taskId: task.id,
          worktree,
          taskBase: task.taskBase!,
        },
      },
      signal,
    })) {
      if (event.type === 'text') answer.output += event.text;
      if (event.type === 'session') answer.sessionId = event.sessionId;
      if (event.type === 'error') answer.failed = true;
      if (event.type === 'done') {
        answer.costUsd += event.costUsd;
        if (event.isError) answer.failed = true;
      }
      yield event;
    }
    if (signal.aborted) answer.failed = true;
    return answer;
  }

  private async *runCommands(
    step: GraphStep,
    run: Run,
    plan: Plan,
    worktree: string,
    taskBase: string,
    secrets: Record<string, string>,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, CommandOutcome> {
    const names = (step.run ?? []).filter(
      (n): n is CheckName => n === 'build' || n === 'lint' || n === 'test',
    );
    let violations: ScopeViolation[];
    try {
      violations = await this.scope.check(worktree, taskBase, plan.scope);
    } catch (error) {
      const result = {
        name: 'test' as CheckName,
        argv: [],
        ok: false,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        output: `Controllo del perimetro non riuscito: ${message(error)}`,
      };
      yield { type: 'commands_finished', id: step.id, ok: false, results: [] };
      return { ok: false, results: [result] };
    }
    if (violations.length) {
      const text = violationsText(violations);
      yield { type: 'scope_violation', id: step.id, violations };
      const result = {
        name: (names[0] ?? 'test') as CheckName,
        argv: [],
        ok: false,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        output: text,
      };
      yield {
        type: 'commands_finished',
        id: step.id,
        ok: false,
        results: [
          {
            name: result.name,
            ok: false,
            exitCode: null,
            timedOut: false,
            durationMs: 0,
          },
        ],
      };
      return { ok: false, results: [result] };
    }

    // The output reaches the user while the commands run, as in the preparation.
    const events: RunEventData[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const running = this.checks
      .run({
        runId: run.id,
        projectId: run.projectId,
        worktree,
        plan,
        names,
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
    // Keep the rejection for the `await` below, not as an unhandled one.
    running.catch(() => undefined);
    for (;;) {
      while (events.length) yield events.shift()!;
      if (finished) break;
      await new Promise<void>((resolve) => (wake = resolve));
    }
    const results = await running;
    const ok = results.every((r) => r.ok);
    yield {
      type: 'commands_finished',
      id: step.id,
      ok,
      results: results.map((r) => ({
        name: r.name,
        ok: r.ok,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
      })),
    };
    return { ok, results };
  }

  /** Yields the commands' output while `work` runs; an Error when it threw. */
  private async *streamChecks(
    work: (onEvent: (event: CheckEvent) => void) => Promise<CheckResult[]>,
  ): AsyncGenerator<RunEventData, CheckResult[] | Error> {
    const events: RunEventData[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const running = work((event) => {
      if (event.type !== 'output') return;
      events.push({ type: 'check_output', name: event.name, text: event.text });
      wake?.();
    }).finally(() => {
      finished = true;
      wake?.();
    });
    running.catch(() => undefined);
    for (;;) {
      while (events.length) yield events.shift()!;
      if (finished) break;
      await new Promise<void>((resolve) => (wake = resolve));
    }
    return running.catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  /** Files a writer may not change, changed since the checkpoint of the protected step. */
  private async protect(
    check: GraphStep,
    writer: GraphStep,
    worktree: string,
    taskBase: string,
    steps: Record<string, { checkpoint?: string }>,
    plan: Plan,
    push: (event: RunEventData) => void,
  ) {
    if (!writer.protect.length) return null;
    const touched = await protectedFiles(
      this.git,
      worktree,
      taskBase,
      steps,
      writer.protect,
      plan.scope.tests,
    );
    if (!touched.length) return null;
    push({ type: 'protect_violation', id: check.id, files: touched });
    return `File protetti modificati:\n${touched.map((f) => `- ${f}`).join('\n')}`;
  }

  /** Ends the run: report, task and mission state, entry. */
  private async finish(
    run: Run,
    task: MissionTask,
    mission: Mission,
    plan: Plan,
    graph: TaskGraph,
    steps: Record<string, unknown>,
    outcome: RunOutcome,
  ) {
    const report = await this.report(
      task,
      mission,
      plan,
      steps as never,
      outcome,
      graph,
    );
    const resultStep = (steps as Record<string, { verdict?: string; stopVerdict?: string }>)[
      graph.result
    ];
    const status = resultStep?.verdict === 'ok' && outcome === 'done' ? 'review' : 'blocked';
    if (status === 'review') await this.squash(task, plan, mission);

    const reportJson = JSON.stringify(report);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.missionTask.updateMany({
        where: { id: task.id, status: 'running' },
        data: {
          status,
          finishedAt: status === 'blocked' ? now : null,
          reportJson,
        },
      });
      if (!moved.count) return;
      const wait =
        status === 'review'
          ? { code: 'task_review', taskId: task.id }
          : { code: 'task_blocked', taskId: task.id };
      await tx.mission.update({
        where: { id: mission.id },
        data: {
          status: 'waiting',
          waitJson: JSON.stringify(wait),
          costUsd: { increment: report.costUsd },
        },
      });
      const cost = report.costUsd;
      await tx.missionEntry.create({
        data: {
          missionId: mission.id,
          taskId: task.id,
          kind: 'wait',
          dataJson: JSON.stringify({ ...wait, report: { ...report, diff: undefined } }),
          notify: true,
        },
      });
      await tx.missionEntry.create({
        data: {
          missionId: mission.id,
          taskId: task.id,
          kind: 'status',
          dataJson: JSON.stringify({
            status,
            taskId: task.id,
            attempt: task.attempts,
            costUsd: cost,
          }),
        },
      });
    });
  }

  /** One commit per task on its branch, then the review sees a single change. */
  private async squash(task: MissionTask, plan: Plan, mission: Mission) {
    if (!task.worktreePath || !task.taskBase) return;
    try {
      const title =
        plan.milestones
          .flatMap((m) => m.tasks)
          .find((t) => t.key === task.key)?.title ?? task.key;
      await squashCheckpoints(this.git, task.worktreePath, task.taskBase, title, {
        Mission: String(mission.id),
        Task: task.key,
      });
    } catch {
      // No changes or no commit: the report tells what the branch holds.
    }
  }

  private async report(
    task: MissionTask,
    mission: Mission,
    plan: Plan,
    steps: Record<
      string,
      {
        output?: string;
        status?: string;
        verdict?: string;
        warning?: string;
        commands?: CommandOutcome;
        review?: { verdict: string; output: string };
        iterations?: unknown[];
        stopVerdict?: string;
        checkpoint?: string;
      }
    >,
    outcome: RunOutcome,
    graph: TaskGraph,
  ): Promise<TaskReport & { previous?: unknown }> {
    let files: TaskReport['diff']['files'] = [];
    let added = 0;
    let removed = 0;
    if (task.worktreePath && task.taskBase) {
      try {
        const entries = await this.git.diff(task.worktreePath, task.taskBase);
        const stat = await this.git.numstat(task.worktreePath, task.taskBase);
        files = entries.map((e) => {
          const n = stat.get(e.file) ?? { added: 0, removed: 0 };
          return {
            path: e.file,
            status: e.status,
            added: n.added,
            removed: n.removed,
          };
        });
        added = files.reduce((a, f) => a + f.added, 0);
        removed = files.reduce((a, f) => a + f.removed, 0);
      } catch {
        // A branch that can't be read leaves an empty diff.
      }
    }

    const result = steps[graph.result];
    const warnings = Object.values(steps)
      .map((s) => s.warning)
      .filter((w): w is string => Boolean(w));
    const needs =
      planTasks(plan).find((t) => t.key === task.key)?.needs ?? [];
    if (needs.length) {
      const rows = await this.prisma.missionTask.findMany({
        where: { missionId: mission.id, key: { in: needs } },
      });
      for (const row of rows) {
        if (row.status === 'skipped') {
          warnings.push(
            `Task ${row.key} was skipped: its work is not in the branch.`,
          );
        }
      }
    }
    const costUsd = Object.values(steps).reduce(
      (sum, s) => sum + ((s as { costUsd?: number }).costUsd ?? 0),
      0,
    );
    const review =
      result?.review ??
      (result?.verdict
        ? { verdict: result.verdict, output: result.output ?? '' }
        : null);

    const blocked = this.blockedOf(outcome, graph, steps, result);
    const previous = parsedReport(task.reportJson)?.previous;
    // The implementer's answer, or the last agent that wrote, is the summary.
    const writer =
      graph.steps.find((step) => step.repeat)?.id ??
      graph.steps.find((step) => step.agent && step.id !== graph.result)?.id;

    return {
      attempt: task.attempts,
      diff: { files, added, removed },
      checks: result?.commands?.results ?? [],
      review,
      iterations: Object.values(steps).reduce(
        (sum, s) => sum + (s.iterations?.length ?? 0),
        0,
      ),
      warnings,
      costUsd,
      ...(blocked ? { blocked } : {}),
      summary: writer
        ? summaryOf({ [writer]: { output: steps[writer]?.output ?? '' } })
        : '',
      ...(previous ? { previous } : {}),
    };
  }

  private blockedOf(
    outcome: RunOutcome,
    graph: TaskGraph,
    steps: Record<
      string,
      {
        status?: string;
        stopVerdict?: string;
        iterations?: unknown[];
        verdict?: string;
      }
    >,
    result?: { verdict?: string },
  ): { reason: BlockedReason; detail: string } | null {
    if (outcome === 'done' && result?.verdict === 'ok') return null;
    const stop = Object.entries(steps).find(([, s]) => s.stopVerdict);
    if (stop) {
      return {
        reason: 'test_errati',
        detail: `La verifica ha dato "${stop[1].stopVerdict}"`,
      };
    }
    const repeating = graph.steps.filter((s) => s.repeat);
    for (const step of repeating) {
      const result = steps[step.id];
      const max = step.repeat!.max;
      const rounds = result?.iterations?.length ?? 0;
      const last = result?.iterations?.at(-1) as
        | { check?: { verdict?: string } }
        | undefined;
      if (
        result?.status === 'failed' &&
        rounds >= max &&
        last?.check?.verdict !== step.repeat!.until
      ) {
        return {
          reason: 'attempts',
          detail: `${step.id} non ha dato "${step.repeat!.until}" in ${max} tentativi`,
        };
      }
    }
    if (result?.verdict && result.verdict !== 'ok') {
      return {
        reason: 'error',
        detail: `La verifica finale ha dato "${result.verdict}"`,
      };
    }
    return { reason: 'error', detail: 'Il task non è arrivato a un verdetto ok' };
  }

  /** Closes a task that couldn't start or hit a technical error. */
  private async close(
    _run: Run,
    task: MissionTask,
    mission: Mission,
    blocked: { reason: BlockedReason; detail: string },
  ) {
    const report: TaskReport = {
      attempt: task.attempts,
      diff: { files: [], added: 0, removed: 0 },
      checks: [],
      review: null,
      iterations: 0,
      warnings: [],
      costUsd: 0,
      blocked,
      summary: '',
    };
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.missionTask.updateMany({
        where: { id: task.id, status: 'running' },
        data: {
          status: 'blocked',
          finishedAt: new Date(),
          reportJson: JSON.stringify(report),
        },
      });
      if (!moved.count) return;
      const wait = { code: 'task_blocked', taskId: task.id };
      await tx.mission.update({
        where: { id: mission.id },
        data: { status: 'waiting', waitJson: JSON.stringify(wait) },
      });
      await tx.missionEntry.create({
        data: {
          missionId: mission.id,
          taskId: task.id,
          kind: 'wait',
          dataJson: JSON.stringify({ ...wait, report }),
          notify: true,
        },
      });
      await tx.missionEntry.create({
        data: {
          missionId: mission.id,
          taskId: task.id,
          kind: 'status',
          dataJson: JSON.stringify({
            status: 'blocked',
            taskId: task.id,
            reason: blocked.reason,
          }),
        },
      });
    });
  }

  /** Queues a new run continuing an interrupted one, from its last checkpoint. */
  async resume(run: Run) {
    if (!run.missionId || !run.missionTaskId) return { runId: run.id };
    const task = await this.prisma.missionTask.findUnique({
      where: { id: run.missionTaskId },
    });
    if (!task || task.status !== 'running') return { runId: run.id };
    const steps = readSteps(run.stepsJson) as unknown as Record<string, unknown>;
    // Keep only closed steps: the interrupted one runs again.
    const kept = Object.fromEntries(
      Object.entries(steps).filter(
        ([, s]) => (s as { status?: string }).status === 'done',
      ),
    );
    const checkpoint =
      Object.values(steps)
        .map((s) => (s as { checkpoint?: string }).checkpoint)
        .filter((c): c is string => Boolean(c))
        .at(-1) ?? task.taskBase;
    if (task.worktreePath && checkpoint) {
      await this.git.resetTo(task.worktreePath, checkpoint).catch(() => undefined);
    }
    let resumed = 0;
    await this.queue.enqueue(
      {
        projectId: run.projectId,
        userId: run.userId,
        kind: 'mission-task',
        title: run.title,
        input: run.input,
        missionId: run.missionId,
        missionTaskId: task.id,
        specJson: run.specJson,
        stepsJson: JSON.stringify(kept),
        writes: false,
        resumeOf: run.id,
      },
      async (created) => {
        resumed = created.id;
        await this.prisma.missionTask.update({
          where: { id: task.id },
          data: { runId: created.id },
        });
      },
    );
    return { runId: resumed };
  }
}
