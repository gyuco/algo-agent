import { Injectable } from '@nestjs/common';
import type { IsEnabled } from '../agents/project-resources.service.js';
import type { Catalog } from '../catalog/catalog.js';
import { normalizeSteps, type GraphStep } from '../catalog/workflow-graph.js';
import { parseRef } from '../providers/model-ref.js';
import { ProvidersService } from '../providers/providers.service.js';
import { VaultService } from '../vault/vault.service.js';
import { CommandLineError, parseCommand } from './command-line.js';
import { GitService } from './git-service.js';
import {
  commandText,
  planTasks,
  type Plan,
  type PlanTask,
} from './plan-schema.js';

/** The keys of `checks` that are commands, as a template's `run` names them. */
const CHECK_COMMANDS = ['setup', 'build', 'lint', 'test'] as const;

export interface PlanValidationResult {
  /** Errors in Italian, each with the plan path they belong to. */
  errors: string[];
  /** Worst-case agent sessions, from the templates' steps and repeats. */
  sessions: number;
}

interface ModelAvailability {
  ids: string[];
  /** Null when the provider is connected but doesn't list its models. */
  models: Map<string, Set<string> | null>;
}

/** Checks a proposed plan against the catalog, the connected providers and git. */
@Injectable()
export class PlanValidationService {
  /** Provider models change rarely: don't probe them on every page load. */
  private readonly snapshots = new Map<
    number,
    { at: number; value: ModelAvailability }
  >();

  constructor(
    private readonly providers: ProvidersService,
    private readonly git: GitService,
    private readonly vault: VaultService,
  ) {}

  async validate(
    userId: number,
    project: { id: number; path: string },
    plan: Plan,
    catalog: Catalog,
    enabled: IsEnabled,
  ): Promise<PlanValidationResult> {
    const errors: string[] = [];
    const availability = await this.availability(userId);
    const available = (where: string, model: string) => {
      const ref = parseRef(model, availability.ids);
      if (!availability.models.has(ref.provider)) {
        errors.push(`${where}: il provider ${ref.provider} non è connesso`);
        return;
      }
      const models = availability.models.get(ref.provider);
      if (models && !models.has(ref.id)) {
        errors.push(`${where}: il modello ${model} non è disponibile`);
      }
    };

    available('team.orchestrator', plan.team.orchestrator);
    if (
      parseRef(plan.team.orchestrator, availability.ids).provider !== 'claude'
    ) {
      errors.push("team.orchestrator: l'orchestratore deve essere Claude");
    }

    await this.roles(plan, catalog, enabled, available, errors);
    this.templates(plan, catalog, enabled, errors);
    this.dependencies(plan, errors);
    this.judges(plan, catalog, errors);

    await this.commands(plan, errors);
    await this.secrets(userId, project.id, plan, errors);

    if (plan.baseBranch) {
      if (!(await this.git.checkRefFormat(project.path, plan.baseBranch))) {
        errors.push(
          `baseBranch: "${plan.baseBranch}" non è un nome di branch valido`,
        );
      } else if (
        (await this.git.isRepository(project.path)) &&
        !(await this.git.branchExists(project.path, plan.baseBranch))
      ) {
        errors.push(
          `baseBranch: il branch "${plan.baseBranch}" non esiste in locale né su origin`,
        );
      }
    }

    return { errors, sessions: this.sessions(plan, catalog) };
  }

  /** Commands are argument vectors, never shell lines (§1.4). */
  private async commands(plan: Plan, errors: string[]) {
    for (const name of CHECK_COMMANDS) {
      const command = plan.checks[name];
      if (!command) continue;
      try {
        parseCommand(commandText(command));
      } catch (error) {
        if (!(error instanceof CommandLineError)) throw error;
        errors.push(`checks.${name}: ${error.message}`);
      }
    }
    if (plan.checks.testFilter) {
      try {
        parseCommand(plan.checks.testFilter);
      } catch (error) {
        if (!(error instanceof CommandLineError)) throw error;
        errors.push(`checks.testFilter: ${error.message}`);
      }
    }
  }

  /** The secrets the plan exposes must exist in the vault. */
  private async secrets(
    userId: number,
    projectId: number,
    plan: Plan,
    errors: string[],
  ) {
    if (!plan.checks.secrets.length) return;
    const values = await this.vault.variables(userId, projectId);
    for (const [i, name] of plan.checks.secrets.entries()) {
      if (!(name in values)) {
        errors.push(
          `checks.secrets[${i}]: il segreto "${name}" non esiste nel vault`,
        );
      }
    }
  }

  private async availability(userId: number): Promise<ModelAvailability> {
    const cached = this.snapshots.get(userId);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const statuses = await this.providers.statuses(userId);
    const ids = this.providers.ids();
    const models = new Map<string, Set<string> | null>();
    for (const status of statuses) {
      if (!status.connected) continue;
      models.set(
        status.provider,
        status.models.length
          ? new Set(status.models.map((m) => parseRef(m.value, ids).id))
          : null,
      );
    }
    const value = { ids, models };
    this.snapshots.set(userId, { at: Date.now(), value });
    return value;
  }

  private async roles(
    plan: Plan,
    catalog: Catalog,
    enabled: IsEnabled,
    available: (where: string, model: string) => void,
    errors: string[],
  ) {
    if (!plan.team.roles.integrator) {
      errors.push('team.roles.integrator: il ruolo è obbligatorio');
    }
    for (const [role, spec] of Object.entries(plan.team.roles)) {
      const at = `team.roles.${role}`;
      const agent = catalog.agents.get(spec.agent);
      if (!agent || !enabled('agent', spec.agent)) {
        errors.push(`${at}.agent: l'agente ${spec.agent} non è disponibile`);
      }
      available(`${at}.model`, spec.model);
    }
    const custom = new Set<string>();
    for (const [i, agent] of plan.team.custom.entries()) {
      const at = `team.custom[${i}]`;
      if (custom.has(agent.key)) {
        errors.push(
          `${at}.key: agente personalizzato duplicato "${agent.key}"`,
        );
      }
      custom.add(agent.key);
      for (const skill of agent.permissions.skills) {
        if (!catalog.skills.has(skill) || !enabled('skill', skill)) {
          errors.push(
            `${at}.permissions.skills: la skill ${skill} non è disponibile`,
          );
        }
      }
      available(`${at}.model`, agent.model);
    }
  }

  private templateOf(plan: Plan, task: PlanTask) {
    return task.template;
  }

  private templates(
    plan: Plan,
    catalog: Catalog,
    enabled: IsEnabled,
    errors: string[],
  ) {
    const customKeys = new Set(plan.team.custom.map((a) => a.key));
    plan.milestones.forEach((milestone, mi) => {
      milestone.tasks.forEach((task, ti) => {
        const at = `milestones[${mi}].tasks[${ti}]`;
        const template = catalog.workflows.get(this.templateOf(plan, task));
        if (!template || template.task !== true) {
          errors.push(
            `${at}.template: "${task.template}" non è un modello di task`,
          );
          return;
        }
        if (!enabled('workflow', task.template)) {
          errors.push(
            `${at}.template: il modello "${task.template}" non è abilitato nel progetto`,
          );
        }
        for (const [role, agent] of Object.entries(task.agents)) {
          if (!customKeys.has(agent)) {
            errors.push(
              `${at}.agents.${role}: "${agent}" non è tra gli agenti personalizzati del team`,
            );
          }
        }
        const steps = normalizeSteps(template.steps);
        // Commands the plan doesn't define are skipped; the final check must still run one (§6.2, rule 2).
        const result = steps.find((s) => s.id === template.result);
        const defined = (result?.run ?? []).filter(
          (name) =>
            (CHECK_COMMANDS as readonly string[]).includes(name) &&
            plan.checks[name as (typeof CHECK_COMMANDS)[number]] !== undefined,
        );
        if (result?.run && !defined.length) {
          errors.push(
            `${at}.template: "${task.template}" verifica con ${result.run.join(', ')}, ma checks non ne definisce nessuno`,
          );
        }
        for (const step of steps) {
          if (!step.agent.startsWith('role:')) continue;
          const role = step.agent.slice('role:'.length);
          if (!plan.team.roles[role]) {
            errors.push(
              `${at}.template: il modello usa il ruolo "${role}", assente in team.roles`,
            );
          }
        }
      });
    });
  }

  /** Unique keys, existing needs, no cycles, and only same or earlier milestones. */
  private dependencies(plan: Plan, errors: string[]) {
    const tasks = planTasks(plan);
    const byKey = new Map<string, { task: PlanTask; milestone: number }>();
    plan.milestones.forEach((milestone, mi) => {
      for (const task of milestone.tasks) {
        if (byKey.has(task.key)) {
          errors.push(`tasks.${task.key}: chiave duplicata nel piano`);
        } else {
          byKey.set(task.key, { task, milestone: mi });
        }
      }
    });

    for (const task of tasks) {
      const mine = byKey.get(task.key);
      task.needs.forEach((need, i) => {
        const other = byKey.get(need);
        if (!other) {
          errors.push(
            `tasks.${task.key}.needs[${i}]: task sconosciuto "${need}"`,
          );
        } else if (mine && other.milestone > mine.milestone) {
          errors.push(
            `tasks.${task.key}.needs[${i}]: "${need}" è in una milestone successiva`,
          );
        }
      });
    }

    // Depth-first: a task still on the stack when met again closes a cycle.
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (key: string, path: string[]): void => {
      if (done.has(key)) return;
      if (visiting.has(key)) {
        errors.push(
          `needs: dipendenze cicliche (${[...path, key].join(' → ')})`,
        );
        return;
      }
      visiting.add(key);
      for (const need of byKey.get(key)?.task.needs ?? []) {
        if (byKey.has(need)) visit(need, [...path, key]);
      }
      visiting.delete(key);
      done.add(key);
    };
    for (const key of byKey.keys()) visit(key, []);
  }

  /** After `agents` substitutions, the judge of a task isn't one of its writers. */
  private judges(plan: Plan, catalog: Catalog, errors: string[]) {
    plan.milestones.forEach((milestone, mi) => {
      milestone.tasks.forEach((task, ti) => {
        const template = catalog.workflows.get(task.template);
        if (!template || template.task !== true) return;
        const steps = normalizeSteps(template.steps);
        const result = steps.find((s) => s.id === template.result);
        if (!result || !result.agent) return;
        const judge = this.resolveAgent(plan, task, result);
        if (!judge) return;
        for (const step of steps) {
          if (step.id === result.id || !step.agent) continue;
          if (this.resolveAgent(plan, task, step) === judge) {
            errors.push(
              `milestones[${mi}].tasks[${ti}].agents: chi giudica (${judge}) è anche chi scrive`,
            );
          }
        }
      });
    });
  }

  private resolveAgent(plan: Plan, task: PlanTask, step: GraphStep) {
    if (!step.agent.startsWith('role:')) return step.agent || null;
    const role = step.agent.slice('role:'.length);
    return task.agents[role] ?? plan.team.roles[role]?.agent ?? null;
  }

  private sessions(plan: Plan, catalog: Catalog) {
    let sessions = 0;
    for (const task of planTasks(plan)) {
      const template = catalog.workflows.get(task.template);
      if (!template) continue;
      const maxRepeat = Math.max(
        1,
        ...template.steps.map((s) => s.repeat?.max ?? 1),
      );
      sessions += template.steps.length * maxRepeat;
    }
    return sessions;
  }

  /** Worst-case agent sessions, without checking providers or git. */
  estimate(plan: Plan, catalog: Catalog) {
    return this.sessions(plan, catalog);
  }
}
