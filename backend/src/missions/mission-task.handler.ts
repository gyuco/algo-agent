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
import { BudgetGuard, shouldInterrupt } from './budget-guard.service.js';
import type { RateLimitSnapshot } from '../claude/rate-limit.js';
import {
  ChecksService,
  type CheckEvent,
  type CheckName,
  type CheckResult,
} from './checks.service.js';
import { GitService } from './git-service.js';
import { MissionEventBus } from './mission-event-bus.js';
import { MissionTools } from './mission-tools.js';
import { planSchema, planTasks, type Plan } from './plan-schema.js';
import { ScopeService, type ScopeViolation } from './scope.service.js';
import {
  checkpoint,
  protectedFiles,
  resetToLastCheckpoint,
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
  /** The perimeter violations found in this attempt (phase 5). */
  violations?: ScopeViolation[];
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

/** The same violation seen by several checks counts once. */
function dedupe(violations: ScopeViolation[]) {
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = JSON.stringify(v);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    private readonly budget: BudgetGuard,
    private readonly bus: MissionEventBus,
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

    const project = await this.projects.get(run.userId, mission.projectId!);
    const catalog = await this.catalogService.forProject(
      run.userId,
      mission.projectId!,
    );
    const enabled = await this.resources.isEnabled(mission.projectId!, catalog);
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

    const all = await this.vault.variables(run.userId, mission.projectId!);
    const secrets = Object.fromEntries(
      plan.data.checks.secrets
        .filter((name) => name in all)
        .map((name) => [name, all[name]]),
    );
    const iterations = new Map<string, number>();
    // §5.7: violations don't all block; they are collected for the closure and the wait.
    const scopeViolations: ScopeViolation[] = [];
    // §2.4: a session that runs out of the five-hour window is cut here, not the run.
    const watch = {
      minRemaining: plan.data.budget.fiveHourMinRemaining,
      cut: new AbortController(),
      cutAborted: false,
    };
    const priorStatus = new Map(
      Object.entries(steps).map(([id, result]) => [id, result.status]),
    );

    // `setup` runs once per task worktree, inside the run: it can be stopped and shows its output.
    const setup = yield* this.streamChecks((onEvent) =>
      this.checks
        .ensureSetup({
          runId: run.id,
          projectId: run.projectId!,
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
          watch,
        ),
      runCommands: (step: GraphStep) =>
        this.runCommands(
          step,
          run,
          plan.data,
          worktree,
          taskBase,
          secrets,
          signal,
          scopeViolations,
        ),
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
        // §5.7: `dependency` blocks the commands; the other violations are annotated.
        const violations = await this.scope.check(
          worktree,
          taskBase,
          plan.data.scope,
        );
        if (violations.length) {
          scopeViolations.push(...violations);
          push({ type: 'scope_violation', id: check.id, violations });
        }
        const blocking = violations.filter((v) => v.kind === 'dependency');
        const parts = [
          output,
          blocking.length ? violationsText(blocking) : null,
        ].filter((p): p is string => Boolean(p));
        return parts.length ? parts.join('\n') : null;
      },
      afterWrite: async (step) => {
        const round = (iterations.get(step.id) ?? 0) + 1;
        iterations.set(step.id, round);
        return checkpoint(this.git, worktree, step.id, round);
      },
      mayStart: async (step: GraphStep) => {
        if (!step.agent) return true;
        const model = byStep.get(step.id)?.spec.model;
        const gate = await this.budget.gate(mission.id, model);
        return gate.ok;
      },
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
    // The mission was stopped while the engine ran. A paused or waiting mission
    // (budget, revision, another task's wait) lets its running tasks finish.
    const current = await this.prisma.mission.findUnique({
      where: { id: mission.id },
      select: { status: true },
    });
    if (!current || !['running', 'paused', 'waiting'].includes(current.status)) {
      return 'done';
    }

    // §2.3/§2.4: the run stops between steps; the task and the mission stay as they are.
    // A session cut by the budget fails its step: it goes back to `pending` too.
    if (outcome === 'waiting' || watch.cutAborted) {
      if (watch.cutAborted) {
        await this.suspend(run, worktree, taskBase, steps, priorStatus);
      }
      return 'waiting';
    }

    await this.finish(
      run,
      task,
      mission,
      plan.data,
      graph,
      steps,
      outcome,
      scopeViolations,
    );
    return 'done';
  }

  /**
   * Puts an interrupted step back to `pending`, without its output or a counted
   * round, and the worktree back to the last checkpoint. The scheduler's resume
   * timer queues the run again when the budget allows it.
   */
  private async suspend(
    run: Run,
    worktree: string,
    taskBase: string,
    steps: StepResults,
    priorStatus: Map<string, string>,
  ) {
    for (const [id, result] of Object.entries(steps)) {
      const before = priorStatus.get(id);
      if (result.status !== 'failed' && result.status !== 'aborted') continue;
      if (before === 'failed') continue;
      result.status = 'pending';
      result.finishedAt = null;
      if (before !== 'done') {
        result.output = '';
        result.costUsd = 0;
        delete result.verdict;
        delete result.review;
        delete result.commands;
        delete result.warning;
        delete result.stopVerdict;
        delete result.error;
      }
    }
    await resetToLastCheckpoint(this.git, worktree, steps, taskBase).catch(
      () => undefined,
    );
    await this.prisma.run.update({
      where: { id: run.id },
      data: { stepsJson: JSON.stringify(steps) },
    });
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
    watch: {
      minRemaining: number;
      cut: AbortController;
      cutAborted: boolean;
    },
  ): AsyncGenerator<RunEventData, Answer> {
    if (!agent) {
      return { output: '', costUsd: 0, failed: true };
    }
    const answer: Answer = { output: '', costUsd: 0, failed: false };
    const sessionSignal = AbortSignal.any([signal, watch.cut.signal]);
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
      signal: sessionSignal,
    })) {
      if (event.type === 'text') answer.output += event.text;
      if (event.type === 'session') answer.sessionId = event.sessionId;
      if (event.type === 'usage' && !watch.cutAborted) {
        const snapshot = event.details.rateLimits as
          | RateLimitSnapshot
          | undefined;
        if (shouldInterrupt(snapshot, watch.minRemaining)) {
          watch.cutAborted = true;
          watch.cut.abort();
        }
      }
      if (event.type === 'error') {
        answer.failed = true;
        answer.error = event.message;
      }
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
    scopeViolations: ScopeViolation[],
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
    // §5.7: a new dependency stops the commands (it isn't installed yet); the
    // other violations are recorded and the commands run.
    scopeViolations.push(...violations);
    const blocking = violations.filter((v) => v.kind === 'dependency');
    if (blocking.length) {
      const text = violationsText(blocking);
      yield { type: 'scope_violation', id: step.id, violations: blocking };
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
      return { ok: false, results: [result], violation: true };
    }

    // The output reaches the user while the commands run, as in the preparation.
    const events: RunEventData[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const running = this.checks
      .run({
        runId: run.id,
        projectId: run.projectId!,
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
    scopeViolations: ScopeViolation[],
  ) {
    const report = await this.report(
      task,
      mission,
      plan,
      steps as never,
      outcome,
      graph,
      scopeViolations,
    );
    const resultStep = (steps as Record<string, { verdict?: string; stopVerdict?: string }>)[
      graph.result
    ];
    const fresh = await this.prisma.mission.findUnique({
      where: { id: mission.id },
      select: { mode: true },
    });
    const auto = fresh?.mode === 'auto';
    const ok = resultStep?.verdict === 'ok' && outcome === 'done';
    // §5.7: a violation at closure waits for the user, instead of a review or a
    // merge. A failed task waits on the perimeter only for a new dependency (the
    // commands couldn't run); otherwise it is blocked as usual.
    const violations = await this.closingViolations(task, plan, scopeViolations);
    const withScope = ok
      ? violations.length > 0
      : violations.some((v) => v.kind === 'dependency');
    const status = withScope ? 'scope' : ok ? (auto ? 'ready' : 'review') : 'blocked';
    if (ok) await this.squash(task, plan, mission);
    if (violations.length) report.violations = violations;
    else delete report.violations;

    const reportJson = JSON.stringify(report);
    const now = new Date();
    const before = await this.lastEntry(mission.id);
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.missionTask.updateMany({
        where: { id: task.id, status: 'running' },
        data: {
          status,
          // A `ready` task waits for the merge, in the order it finished.
          finishedAt: status === 'review' ? null : now,
          reportJson,
        },
      });
      if (!moved.count) return;
      // §5.1: in automatic mode the scheduler waits on it only once nothing else runs.
      if (status === 'scope' && !auto) {
        const wait = {
          code: 'scope',
          taskId: task.id,
          violations,
        };
        await tx.mission.update({
          where: { id: mission.id },
          data: {
            status: 'waiting',
            waitJson: JSON.stringify(wait),
            costUsd: { increment: report.costUsd },
          },
        });
        await tx.missionEntry.create({
          data: {
            missionId: mission.id,
            taskId: task.id,
            kind: 'wait',
            dataJson: JSON.stringify({
              ...wait,
              report: { ...report, diff: undefined },
            }),
            notify: true,
          },
        });
        await tx.missionEntry.create({
          data: {
            missionId: mission.id,
            taskId: task.id,
            kind: 'status',
            dataJson: JSON.stringify({ status, taskId: task.id }),
          },
        });
        return;
      }
      if (auto) {
        // §5.3: no Ok from the user; the scheduler merges it, or the dependents stop.
        await tx.mission.update({
          where: { id: mission.id },
          data: { costUsd: { increment: report.costUsd } },
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
              costUsd: report.costUsd,
            }),
          },
        });
        return;
      }
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
    await this.publishSince(mission.id, before);
  }

  /**
   * The violations left at closure: the task's final diff, so one the agent
   * fixed later doesn't count. Those seen during the run are the fallback.
   */
  private async closingViolations(
    task: MissionTask,
    plan: Plan,
    seen: ScopeViolation[],
  ): Promise<ScopeViolation[]> {
    if (!task.worktreePath || !task.taskBase) return dedupe(seen);
    try {
      return await this.scope.check(task.worktreePath, task.taskBase, plan.scope);
    } catch {
      return dedupe(seen);
    }
  }

  /** The last entry of the mission, so entries created in a transaction can be published. */
  private async lastEntry(missionId: number) {
    const last = await this.prisma.missionEntry.aggregate({
      where: { missionId },
      _max: { id: true },
    });
    return last._max.id ?? 0;
  }

  private async publishSince(missionId: number, after: number) {
    const rows = await this.prisma.missionEntry.findMany({
      where: { missionId, id: { gt: after } },
      orderBy: { id: 'asc' },
    });
    for (const row of rows) this.bus.publish(row);
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
    scopeViolations: ScopeViolation[] = [],
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
      ...(scopeViolations.length ? { violations: scopeViolations } : {}),
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
        error?: string;
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
    // An agent that failed (provider down, no credit…) says why.
    const failed = Object.entries(steps).find(([, s]) => s.error);
    if (failed) {
      const model = graph.agents?.[failed[0]]?.spec.model;
      return {
        reason: 'error',
        detail: `${failed[0]}${model ? ` (${model})` : ''}: ${failed[1].error}`,
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
    const before = await this.lastEntry(mission.id);
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
    await this.publishSince(mission.id, before);
  }

  /** Queues a new run continuing an interrupted one, from its last checkpoint. */
  async resume(run: Run) {
    if (!run.missionId || !run.missionTaskId) return { runId: run.id };
    const task = await this.prisma.missionTask.findUnique({
      where: { id: run.missionTaskId },
    });
    if (!task || task.status !== 'running') return { runId: run.id };
    const steps = readSteps(run.stepsJson);
    // Keep only closed steps: the interrupted one runs again.
    const kept = Object.fromEntries(
      Object.entries(steps).filter(([, s]) => s.status === 'done'),
    );
    await resetToLastCheckpoint(
      this.git,
      task.worktreePath ?? '',
      steps,
      task.taskBase ?? '',
    ).catch(() => undefined);
    let resumed = 0;
    await this.queue.enqueue(
      {
        projectId: run.projectId!,
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
