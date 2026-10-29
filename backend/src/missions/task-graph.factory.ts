import { Injectable } from '@nestjs/common';
import type { AgentSpec, WorkflowSpec } from '../catalog/catalog.js';
import type { Catalog } from '../catalog/catalog.js';
import type { GraphStep } from '../catalog/workflow-graph.js';
import { normalizeSteps, sortSteps } from '../catalog/workflow-graph.js';
import type { Mission, MissionTask } from '../generated/prisma/client.js';
import { commandText, type Plan, type PlanTask } from './plan-schema.js';

/** An agent a step of a task uses, with the tools it may call. */
export interface ResolvedAgent {
  spec: AgentSpec;
  tools: ('run_checks')[];
  /** The plan role the agent fills, when the template named one. */
  role?: string;
}

/** A task's model, frozen when its run starts. */
export interface TaskGraph {
  templateKey: string;
  result: string;
  /** The steps in order, with `role:` resolved to the agent of each step. */
  steps: GraphStep[];
  /** The agent of each step, by step id. */
  agents: Record<string, ResolvedAgent>;
}

/** The roles and custom agents of the plan, plus the catalog they resolve against. */
export interface TaskTeam {
  roles: Plan['team']['roles'];
  custom: Plan['team']['custom'];
  agents: Map<string, AgentSpec>;
}

/** A task this one depends on, as `{{task}}` tells it. */
export interface Dependency {
  key: string;
  title: string;
  summary: string;
  commit: string;
  skipped?: boolean;
}

/** The notes and previous attempt that go into `{{task}}`. */
export interface Attempt {
  notes: string[];
  previous?: { diff: string; review: string };
}

/** What counts as an agent of the catalog, to tell a role from a key. */
const ROLE = /^role:(.+)$/;

/** Builds a task's graph from its template and writes the `{{task}}` text. */
@Injectable()
export class TaskGraphFactory {
  build(
    mission: Mission,
    plan: Plan,
    task: PlanTask & { milestone: string },
    template: WorkflowSpec,
    team: TaskTeam,
  ): TaskGraph {
    if (!template.task || !template.result) {
      throw new Error(`Il workflow ${template.key} non è un modello di task`);
    }
    const steps = normalizeSteps(template.steps);
    const agents: Record<string, ResolvedAgent> = {};
    for (const step of steps) {
      if (!step.agent) continue;
      const resolved = this.resolve(step.agent, task, team);
      agents[step.id] = resolved;
      // The engine only needs an agent label; the resolved spec is by step id.
      step.agent = resolved.spec.key;
    }
    const sorted = sortSteps(steps);
    if (!sorted) throw new Error('Le dipendenze del modello di task formano un ciclo');
    return {
      templateKey: template.key,
      result: template.result,
      steps: sorted,
      agents,
    };
  }

  private resolve(ref: string, task: PlanTask, team: TaskTeam): ResolvedAgent {
    const role = ROLE.exec(ref)?.[1];
    if (!role) return this.fromCatalog(ref, team);

    const custom = task.agents[role];
    if (custom) {
      const spec = team.custom.find((c) => c.key === custom);
      if (!spec) {
        throw new Error(
          `Il task ${task.key} usa l'agente custom "${custom}", che il piano non definisce`,
        );
      }
      return {
        spec: {
          key: spec.key,
          description: spec.description,
          enabledByDefault: true,
          maxTurns: 80,
          permissions: {
            files: spec.permissions.files,
            skills: spec.permissions.skills,
            tools: [],
            mcp: [],
          },
          prompt: spec.prompt,
          model: spec.model,
        },
        tools: spec.permissions.files === 'write' ? ['run_checks'] : [],
        role,
      };
    }

    const assigned = team.roles[role];
    if (!assigned) {
      throw new Error(
        `Il task ${task.key} usa il ruolo "${role}", che il piano non definisce`,
      );
    }
    const base = team.agents.get(assigned.agent);
    if (!base) {
      throw new Error(
        `Il ruolo "${role}" usa l'agente "${assigned.agent}", che il catalogo non ha`,
      );
    }
    return {
      spec: {
        ...base,
        model: assigned.model,
        maxTurns: assigned.maxTurns,
      },
      tools: base.permissions.files === 'write' ? ['run_checks'] : [],
      role,
    };
  }

  private fromCatalog(ref: string, team: TaskTeam): ResolvedAgent {
    const base = team.agents.get(ref);
    if (!base) throw new Error(`L'agente "${ref}" non è nel catalogo`);
    return {
      spec: base,
      tools: base.permissions.files === 'write' ? ['run_checks'] : [],
    };
  }

  /** Why the graph can't start any more, e.g. an agent switched off; empty when it can. */
  unavailable(
    graph: TaskGraph,
    catalog: Catalog,
    enabled: (
      kind: 'agent' | 'tool' | 'mcp' | 'skill' | 'workflow',
      key: string,
    ) => boolean,
  ) {
    const errors = new Set<string>();
    for (const { spec } of Object.values(graph.agents)) {
      // A custom agent of the plan isn't in the catalog; a catalog one that
      // disappeared means the plan can't run any more.
      if (catalog.agents.has(spec.key) && !enabled('agent', spec.key)) {
        errors.add(`L'agente ${spec.key} è disattivato nel progetto`);
      }
    }
    return [...errors];
  }

  /** The `{{task}}` text: the task, its notes, the previous attempt and its dependencies. */
  text(
    mission: Mission,
    plan: Plan,
    task: PlanTask & { milestone: string },
    attempt: Attempt,
    dependencies: Dependency[] = [],
  ) {
    const title = task.title ?? task.key;
    const milestone =
      plan.milestones.find((m) => m.id === task.milestone)?.title ??
      task.milestone;
    const lines = [
      `## Task ${task.key}: ${title}`,
      `Milestone: ${milestone || mission.title}`,
      '',
      '### Acceptance criteria',
      ...task.acceptance.map((a) => `- ${a}`),
    ];

    if (attempt.notes.length) {
      lines.push('', '### User notes');
      attempt.notes.forEach((note, i) => lines.push(`${i + 1}. ${note}`));
    }
    if (attempt.previous) {
      lines.push(
        '',
        '### Previous attempt',
        'Diff (truncated to 20 KB):',
        '```diff',
        attempt.previous.diff,
        '```',
        `Last review: ${attempt.previous.review}`,
      );
    }
    if (dependencies.length) {
      lines.push('', '### Tasks this one depends on');
      for (const dep of dependencies) {
        lines.push(
          dep.skipped
            ? `- ${dep.key} — ${dep.title}: skipped, its work is not in the branch.`
            : `- ${dep.key} — ${dep.title}: ${dep.summary} (commit ${dep.commit.slice(0, 7)})`,
        );
      }
    }

    const commands = [
      plan.checks.build ? `build: ${commandText(plan.checks.build)}` : null,
      plan.checks.lint ? `lint: ${commandText(plan.checks.lint)}` : null,
      `test: ${commandText(plan.checks.test)}`,
    ].filter((c): c is string => Boolean(c));
    lines.push(
      '',
      '### Project commands',
      `${commands.join('  ')}  (run them with the run_checks tool)`,
    );
    return lines.join('\n');
  }

  /** The task's notes, as saved by the actions. */
  notes(task: MissionTask): string[] {
    try {
      const value = JSON.parse(task.notesJson) as unknown;
      return Array.isArray(value)
        ? value.filter((n): n is string => typeof n === 'string')
        : [];
    } catch {
      return [];
    }
  }
}
