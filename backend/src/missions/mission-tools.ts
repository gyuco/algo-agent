import { Injectable } from '@nestjs/common';
import {
  tool,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Mission } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VaultService } from '../vault/vault.service.js';
import { ChecksService, type CheckResult } from './checks.service.js';
import { validTestPattern } from './command-line.js';
import { MissionEventBus } from './mission-event-bus.js';
import { readProgress, writeProgress } from './mission-progress.js';
import { planChanges } from './plan-diff.js';
import { canonicalJson, planSchema, type Plan } from './plan-schema.js';
import type { PlanValidationResult } from './plan-validation.js';
import { ScopeService, type ScopeViolation } from './scope.service.js';
import { GitService } from './git-service.js';

/** What the task tools know: the worktree, its base commit and the approved plan. */
export interface TaskToolScope {
  missionId: number;
  runId: number;
  taskId?: number;
  userId: number;
  projectId: number;
  worktree: string;
  /** The commit the task's diff is measured from. */
  taskBase: string;
  plan: Plan;
  /** The task's run signal, to stop the commands with it. */
  signal?: AbortSignal;
}

export interface MissionToolScope {
  mission: Mission;
  runId: number;
  purpose: 'briefing' | 'milestone' | 'revision' | 'final';
  /** The milestone under review, for `milestone` and `final` purposes. */
  milestone?: string;
  validate: (plan: Plan) => Promise<PlanValidationResult>;
  /** Tells the runtime that no other tool may run in this turn. */
  closeTurn: () => void;
  /** Claims the end of the turn for this call; false when another call already did. */
  beginClose: () => boolean;
  /** Releases the claim when the plan is invalid and the turn can go on. */
  cancelClose: () => void;
}

const text = (value: string) => ({
  content: [{ type: 'text' as const, text: value }],
});
const failure = (value: string) => ({
  content: [{ type: 'text' as const, text: value }],
  isError: true,
});

/** The last 16 KB of a command's output, which is the part that matters. */
function tail(text: string, bytes = 16 * 1024) {
  return Buffer.byteLength(text) <= bytes
    ? text
    : Buffer.from(text).subarray(-bytes).toString('utf8');
}

function formatResults(results: CheckResult[]) {
  return JSON.stringify(
    results.map((r) => ({
      name: r.name,
      ok: r.ok,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      output: tail(r.output),
    })),
    null,
    2,
  );
}

function describeViolations(violations: ScopeViolation[]) {
  return violations
    .map((v) => {
      if (v.kind === 'dependency') {
        return `- ${v.file}: nuova dipendenza "${v.name}" fuori da scope.dependencies`;
      }
      if (v.kind === 'migration') {
        return `- ${v.file}: migrazione non consentita (scope.migrations è false)`;
      }
      if (v.kind === 'deleted') return `- ${v.file}: file cancellato`;
      return `- ${v.file}: fuori da scope.paths`;
    })
    .join('\n');
}

/**
 * The orchestrator's tools, kept out of APP_TOOLS: they exist only inside a
 * briefing and must not appear among the project's switchable resources.
 */
@Injectable()
export class MissionTools {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: MissionEventBus,
    private readonly checks: ChecksService,
    private readonly scope: ScopeService,
    private readonly vault: VaultService,
    private readonly git: GitService,
  ) {}

  forRun(scope: MissionToolScope): SdkMcpToolDefinition<any>[] {
    if (scope.purpose === 'briefing') {
      return [this.askUser(scope), this.proposePlan(scope)];
    }
    const tools: SdkMcpToolDefinition<any>[] = [
      this.taskReport(scope),
      this.recordDecision(scope),
      this.updatePlan(scope),
    ];
    if (scope.purpose !== 'revision') tools.push(this.closeMilestone(scope));
    return tools;
  }

  /** The tools of a task's agents: `run_checks`. */
  taskTools(scope: TaskToolScope): SdkMcpToolDefinition<any>[] {
    return [this.runChecksTool(scope)];
  }

  /**
   * Runs the plan's commands for the agent, after the perimeter check. Returns
   * the commands' outcome as text; `ok` is false on violations and failures.
   */
  async runChecks(
    scope: TaskToolScope,
    input: { names: ('build' | 'lint' | 'test')[]; pattern?: string },
  ): Promise<{ ok: boolean; text: string }> {
    let violations: ScopeViolation[];
    try {
      violations = await this.scope.check(
        scope.worktree,
        scope.taskBase,
        scope.plan.scope,
      );
    } catch (error) {
      return {
        ok: false,
        text: `Controllo del perimetro non riuscito: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (violations.length) {
      // §5.7: a new dependency blocks the commands; the other violations are annotated.
      const blocking = violations.filter((v) => v.kind === 'dependency');
      if (blocking.length) {
        return {
          ok: false,
          text: `Fuori perimetro:\n${describeViolations(blocking)}`,
        };
      }
    }

    if (input.pattern !== undefined) {
      if (!scope.plan.checks.testFilter) {
        return {
          ok: false,
          text: 'Il piano non definisce checks.testFilter: il pattern non è accettato',
        };
      }
      if (!validTestPattern(input.pattern)) {
        return {
          ok: false,
          text: 'Pattern non valido: lettere, cifre e _ . / * : @ - (al massimo 200 caratteri)',
        };
      }
    }

    const all = await this.vault.variables(scope.userId, scope.projectId);
    const secrets = Object.fromEntries(
      scope.plan.checks.secrets
        .filter((name) => name in all)
        .map((name) => [name, all[name]]),
    );
    const request = {
      runId: scope.runId,
      projectId: scope.projectId,
      worktree: scope.worktree,
      plan: scope.plan,
      names: input.names,
      testPattern: input.pattern,
      secrets,
      signal: scope.signal ?? new AbortController().signal,
    };

    const setup = await this.checks.ensureSetup(request);
    if (setup && !setup.ok) {
      return { ok: false, text: formatResults([setup]) };
    }
    const results = await this.checks.run(request);
    const violationsNote = violations.length
      ? `Violazioni del perimetro annotate nel report:\n${describeViolations(violations)}\n\n`
      : '';
    return {
      ok: results.every((r) => r.ok),
      text: violationsNote + formatResults(results),
    };
  }

  private runChecksTool(scope: TaskToolScope) {
    return tool(
      'run_checks',
      "Run the checks of the approved plan (build, lint, test) in the task worktree. Only the plan's commands run; the perimeter is checked first.",
      {
        names: z.array(z.enum(['build', 'lint', 'test'])).min(1),
        pattern: z.string().max(200).optional(),
      },
      async ({ names, pattern }) => {
        const result = await this.runChecks(scope, { names, pattern });
        return result.ok ? text(result.text) : failure(result.text);
      },
      { annotations: { readOnlyHint: false } },
    );
  }

  private askUser(scope: MissionToolScope) {
    return tool(
      'ask_user',
      'Ask the user one question in the briefing, optionally with answers to choose from. The turn ends after it.',
      {
        question: z.string().trim().min(1).max(4_000),
        options: z.array(z.string().trim().min(1).max(200)).max(6).optional(),
      },
      async ({ question, options }) => {
        if (!scope.beginClose()) {
          return failure('Il turno è già chiuso: non fare altre domande.');
        }
        const data = { question, ...(options?.length ? { options } : {}) };
        const entry = await this.prisma
          .$transaction(async (tx) => {
            const entry = await tx.missionEntry.create({
              data: {
                missionId: scope.mission.id,
                kind: 'question',
                dataJson: JSON.stringify(data),
              },
            });
            const { count } = await tx.mission.updateMany({
              where: { id: scope.mission.id, status: 'briefing' },
              data: {
                waitJson: JSON.stringify({
                  code: 'question',
                  entryId: entry.id,
                }),
              },
            });
            if (!count) throw new Error('not-briefing');
            return entry;
          })
          .catch((error: unknown) => {
            if (error instanceof Error && error.message === 'not-briefing') {
              return null;
            }
            throw error;
          });
        if (!entry) {
          return failure(
            'La missione non è più nel briefing: la domanda non è stata registrata.',
          );
        }
        this.bus.publish(entry);
        scope.closeTurn();
        return text(
          'Domanda registrata. Turno chiuso: termina ora senza altro testo.',
        );
      },
      { annotations: { readOnlyHint: false } },
    );
  }

  private proposePlan(scope: MissionToolScope) {
    return tool(
      'propose_plan',
      'Propose the complete mission plan. Validation errors come back to you: fix them and call it again.',
      { plan: planSchema },
      async ({ plan }) => {
        if (!scope.beginClose()) {
          return failure('Il turno è già chiuso: non proporre un altro piano.');
        }
        const parsed = planSchema.safeParse(plan);
        if (!parsed.success) {
          scope.cancelClose();
          return text(`Piano non valido:\n${z.prettifyError(parsed.error)}`);
        }
        let validation: PlanValidationResult;
        try {
          validation = await scope.validate(parsed.data);
        } catch (error) {
          scope.cancelClose();
          return failure(
            `Validazione non riuscita: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (validation.errors.length) {
          scope.cancelClose();
          return text(
            `Piano non valido: correggi e riprova.\n- ${validation.errors.join('\n- ')}`,
          );
        }

        const canonical = canonicalJson(parsed.data);
        const current = await this.prisma.mission.findUnique({
          where: { id: scope.mission.id },
          select: { planJson: true, planVersion: true, status: true },
        });
        if (!current || current.status !== 'briefing') {
          return failure(
            'La missione non è più nel briefing: il piano non è stato salvato.',
          );
        }
        if (current.planJson === canonical) {
          const { count } = await this.prisma.mission.updateMany({
            where: { id: scope.mission.id, status: 'briefing' },
            data: { status: 'planned', waitJson: null },
          });
          if (count) {
            const entry = await this.prisma.missionEntry.create({
              data: {
                missionId: scope.mission.id,
                kind: 'status',
                dataJson: JSON.stringify({
                  status: 'planned',
                  version: current.planVersion,
                }),
              },
            });
            this.bus.publish(entry);
          }
          scope.closeTurn();
          return text(
            `Piano identico alla versione ${current.planVersion}. Turno chiuso: termina ora.`,
          );
        }

        const version = current.planVersion + 1;
        const entry = await this.prisma
          .$transaction(async (tx) => {
            const { count } = await tx.mission.updateMany({
              where: { id: scope.mission.id, status: 'briefing' },
              data: {
                status: 'planned',
                title: parsed.data.title,
                planJson: canonical,
                planVersion: version,
                waitJson: null,
              },
            });
            if (!count) throw new Error('not-briefing');
            return tx.missionEntry.create({
              data: {
                missionId: scope.mission.id,
                kind: 'plan',
                dataJson: JSON.stringify({ version, plan: parsed.data }),
              },
            });
          })
          .catch((error: unknown) => {
            if (error instanceof Error && error.message === 'not-briefing') {
              return null;
            }
            throw error;
          });
        if (!entry) {
          return failure(
            'La missione non è più nel briefing: il piano non è stato salvato.',
          );
        }
        this.bus.publish(entry);
        scope.closeTurn();
        return text(
          `Piano salvato come versione ${version}. Turno chiuso: termina ora senza altro testo.`,
        );
      },
      { annotations: { readOnlyHint: false } },
    );
  }

  /** The full report of a task, with its diff cut short. Doesn't close the turn. */
  private taskReport(scope: MissionToolScope) {
    return tool(
      'task_report',
      "Read a task of the mission in full: state, report and its diff. Use it before deciding what to change.",
      { key: z.string().trim().min(1).max(64) },
      async ({ key }) => {
        const task = await this.prisma.missionTask.findFirst({
          where: { missionId: scope.mission.id, key },
        });
        if (!task) return failure(`Il task ${key} non esiste nella missione.`);
        let diff = '';
        if (task.taskBase && task.branch && scope.mission.worktreePath) {
          diff = await this.git
            .diffText(
              scope.mission.worktreePath,
              task.taskBase,
              task.branch,
              20 * 1024,
            )
            .catch(() => '');
        }
        return text(
          JSON.stringify(
            {
              key: task.key,
              milestone: task.milestone,
              status: task.status,
              attempts: task.attempts,
              report: task.reportJson ? JSON.parse(task.reportJson) : null,
              diff,
            },
            null,
            2,
          ),
        );
      },
      { annotations: { readOnlyHint: true } },
    );
  }

  /** A choice the orchestrator made by itself: it goes to the log and the pull request. */
  private recordDecision(scope: MissionToolScope) {
    return tool(
      'record_decision',
      'Record a decision you took without the user, with its reason. It appears in the mission log and the pull request.',
      {
        question: z.string().trim().min(1).max(2_000),
        options: z.array(z.string().trim().min(1).max(500)).max(6).optional(),
        chosen: z.string().trim().min(1).max(2_000),
        reason: z.string().trim().min(1).max(4_000),
      },
      async ({ question, options, chosen, reason }) => {
        const entry = await this.prisma.missionEntry.create({
          data: {
            missionId: scope.mission.id,
            kind: 'decision',
            dataJson: JSON.stringify({
              question,
              ...(options?.length ? { options } : {}),
              chosen,
              reason,
            }),
          },
        });
        this.bus.publish(entry);
        return text('Decisione registrata.');
      },
      { annotations: { readOnlyHint: false } },
    );
  }

  /** Confirms the milestone under review, and closes the turn. */
  private closeMilestone(scope: MissionToolScope) {
    return tool(
      'close_milestone',
      'Confirm the milestone under review. The next milestone may start after it. The turn ends here.',
      { summary: z.string().trim().min(1).max(4_000) },
      async ({ summary }) => {
        if (!scope.milestone) {
          return failure('Nessuna milestone da chiudere in questo turno.');
        }
        if (!scope.beginClose()) {
          return failure('Il turno è già chiuso.');
        }
        const current = await this.prisma.mission.findUnique({
          where: { id: scope.mission.id },
        });
        if (!current) {
          scope.cancelClose();
          return failure('Missione non trovata.');
        }
        const progress = readProgress(current);
        if (!progress.reviewedMilestones.includes(scope.milestone)) {
          progress.reviewedMilestones.push(scope.milestone);
        }
        const entry = await this.prisma
          .$transaction(async (tx) => {
            const { count } = await tx.mission.updateMany({
              where: {
                id: scope.mission.id,
                progressJson: current.progressJson,
              },
              data: {
                progressJson: writeProgress(progress),
                waitJson: null,
              },
            });
            if (!count) throw new Error('changed');
            return tx.missionEntry.create({
              data: {
                missionId: scope.mission.id,
                kind: 'milestone',
                dataJson: JSON.stringify({
                  id: scope.milestone,
                  summary,
                }),
              },
            });
          })
          .catch(() => null);
        if (!entry) {
          scope.cancelClose();
          return failure('La missione è cambiata nel frattempo: riprova.');
        }
        this.bus.publish(entry);
        scope.closeTurn();
        return text(
          'Milestone confermata. Turno chiuso: termina ora senza altro testo.',
        );
      },
      { annotations: { readOnlyHint: false } },
    );
  }

  /** §5.5: validates and applies a plan change, or waits for the user. */
  private updatePlan(scope: MissionToolScope) {
    return tool(
      'update_plan',
      'Change the plan during the mission. Runs already done keep their tasks; a scope, checks, team, budget or new template change waits for the user. A valid plan closes the turn.',
      {
        plan: planSchema,
        reason: z.string().trim().min(1).max(4_000),
      },
      async ({ plan, reason }) => {
        if (!scope.beginClose()) {
          return failure('Il turno è già chiuso: non proporre un altro piano.');
        }
        const parsed = planSchema.safeParse(plan);
        if (!parsed.success) {
          scope.cancelClose();
          return text(`Piano non valido:\n${z.prettifyError(parsed.error)}`);
        }
        const current = await this.prisma.mission.findUnique({
          where: { id: scope.mission.id },
        });
        if (!current?.planJson) {
          scope.cancelClose();
          return failure('La missione non ha un piano approvato.');
        }
        const approved = planSchema.safeParse(JSON.parse(current.planJson));
        if (!approved.success) {
          scope.cancelClose();
          return failure('Il piano approvato non è più leggibile.');
        }
        if (canonicalJson(parsed.data) === canonicalJson(approved.data)) {
          scope.closeTurn();
          return text('Piano invariato. Turno chiuso: termina ora.');
        }
        const rows = await this.prisma.missionTask.findMany({
          where: { missionId: scope.mission.id },
        });
        const progress = readProgress(current);
        const changes = planChanges(
          approved.data,
          parsed.data,
          rows,
          progress.reviewedMilestones,
        );
        if (changes.errors.length) {
          scope.cancelClose();
          return text(
            `Il piano cambia cose che non si possono cambiare:\n- ${changes.errors.join('\n- ')}`,
          );
        }
        let validation: PlanValidationResult;
        try {
          validation = await scope.validate(parsed.data);
        } catch (error) {
          scope.cancelClose();
          return failure(
            `Validazione non riuscita: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (validation.errors.length) {
          scope.cancelClose();
          return text(
            `Piano non valido: correggi e riprova.\n- ${validation.errors.join('\n- ')}`,
          );
        }

        const auto = current.mode === 'auto' && !changes.requiresUser;
        const version = current.planVersion + 1;
        const currentWait = current.waitJson
          ? (JSON.parse(current.waitJson) as {
              previous?: { milestone?: string };
              milestone?: string;
            })
          : null;
        // A plan applied during a milestone review confirms that milestone (§5.4).
        const milestone =
          scope.milestone ?? currentWait?.milestone ?? currentWait?.previous?.milestone;
        const planTasksAfter = parsed.data.milestones.flatMap((milestone) =>
          milestone.tasks.map((task) => ({ ...task, milestone: milestone.id })),
        );
        // Corrective tasks reopen the milestone: its checks and review run again after them.
        const corrected = planTasksAfter.some(
          (task) =>
            task.milestone === milestone &&
            changes.changes.addedTasks.includes(task.key),
        );
        const reviewed = [...progress.reviewedMilestones];
        if (auto && milestone && !corrected && !reviewed.includes(milestone)) {
          reviewed.push(milestone);
        }
        const progressJson = writeProgress({
          ...progress,
          reviewedMilestones: reviewed,
        });
        const waitingReason = !auto
          ? current.mode !== 'auto'
            ? 'modalità passo-passo'
            : changes.requiresUser
              ? `cambia ${[
                  ...changes.changes.sections,
                  ...(changes.changes.addedMilestones.length ? ['milestone'] : []),
                ].join(', ') || 'un template nuovo'}`
              : 'serve il tuo Ok'
          : null;

        const entry = await this.prisma
          .$transaction(async (tx) => {
            const { count } = await tx.mission.updateMany({
              where: {
                id: scope.mission.id,
                planVersion: current.planVersion,
              },
              data: {
                planJson: canonicalJson(parsed.data),
                planVersion: version,
                title: parsed.data.title,
                ...(auto
                  ? {
                      approvedVersion: version,
                      waitJson: null,
                      progressJson,
                    }
                  : {
                      status: 'waiting',
                      waitJson: JSON.stringify({
                        code: 'milestone',
                        planVersion: version,
                        detail: waitingReason,
                        ...(milestone ? { milestone } : {}),
                        previousPlan: approved.data,
                        previous: current.waitJson
                          ? JSON.parse(current.waitJson)
                          : undefined,
                      }),
                    }),
              },
            });
            if (!count) throw new Error('changed');
            if (changes.changes.removedTasks.length) {
              await tx.missionTask.deleteMany({
                where: {
                  missionId: scope.mission.id,
                  key: { in: changes.changes.removedTasks },
                  status: 'pending',
                },
              });
            }
            const present = new Set(rows.map((row) => row.key));
            const added = planTasksAfter.filter(
              (task) => !present.has(task.key),
            );
            if (added.length) {
              await tx.missionTask.createMany({
                data: added.map((task) => ({
                  missionId: scope.mission.id,
                  key: task.key,
                  milestone: task.milestone,
                  status: 'pending',
                })),
              });
            }
            for (const key of changes.changes.changedTasks) {
              const planned = planTasksAfter.find((task) => task.key === key);
              if (!planned) continue;
              await tx.missionTask.updateMany({
                where: {
                  missionId: scope.mission.id,
                  key,
                  status: 'pending',
                },
                data: { milestone: planned.milestone },
              });
            }
            return tx.missionEntry.create({
              data: {
                missionId: scope.mission.id,
                kind: 'plan',
                dataJson: JSON.stringify({ version, plan: parsed.data }),
              },
            });
          })
          .catch(() => null);
        if (!entry) {
          scope.cancelClose();
          return failure('La missione è cambiata nel frattempo: riprova.');
        }
        this.bus.publish(entry);
        const decision = await this.prisma.missionEntry.create({
          data: {
            missionId: scope.mission.id,
            kind: 'decision',
            dataJson: JSON.stringify({
              question: 'Piano aggiornato durante la missione',
              chosen: auto ? `applicato (v${version})` : `v${version}, serve il tuo Ok`,
              reason,
              changes: {
                added: changes.changes.addedTasks,
                removed: changes.changes.removedTasks,
                changed: changes.changes.changedTasks,
                corrective: changes.corrective,
              },
            }),
          },
        });
        this.bus.publish(decision);
        scope.closeTurn();
        return text(
          auto
            ? `Piano salvato e applicato come versione ${version}. Turno chiuso: termina ora.`
            : `Piano salvato come versione ${version}: aspetta l'Ok dell'utente. Turno chiuso: termina ora.`,
        );
      },
      { annotations: { readOnlyHint: false } },
    );
  }
}
