import { z } from 'zod';
import { TEST_PATTERN_MARKER } from './command-line.js';

const keySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'minuscole, cifre e trattini');

/**
 * A path or glob inside the worktree: relative, without `..` segments. From
 * phase 2 these become the commands' working folders and the scope check.
 */
const relativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.startsWith('~') &&
      !/^[A-Za-z]:/.test(p) &&
      !p.split(/[/\\]/).includes('..'),
    'deve essere un percorso relativo al progetto, senza ".."',
  );

/** A command as written: a string, or an object with its own working folder. */
const commandSchema = z.union([
  z.string().trim().min(1).max(2_000),
  z
    .object({
      run: z.string().trim().min(1).max(2_000),
      workdir: relativePathSchema.optional(),
    })
    .strict(),
]);

const modelSchema = z.string().trim().min(1).max(160);
const roleName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'minuscole, cifre e trattini');

const roleSchema = z
  .object({
    agent: keySchema,
    model: modelSchema,
    /** Agent turns of this role in one task; 80 by default, at most 100. */
    maxTurns: z.number().int().min(1).max(100).default(80),
  })
  .strict();

const customAgentSchema = z
  .object({
    key: keySchema,
    description: z.string().trim().min(1).max(500),
    model: modelSchema,
    permissions: z
      .object({
        files: z.enum(['none', 'read', 'write']).default('none'),
        skills: z.array(keySchema).default([]),
      })
      .strict()
      .prefault({}),
    prompt: z.string().trim().min(1).max(50_000),
  })
  .strict();

const taskSchema = z
  .object({
    key: keySchema,
    title: z.string().trim().min(1).max(200).optional(),
    /** Model of task in the catalog; `task-tdd` by default. */
    template: keySchema.default('task-tdd'),
    /** Custom agent to use in place of a role. */
    agents: z.record(roleName, keySchema).default({}),
    needs: z.array(keySchema).default([]),
    acceptance: z
      .array(z.string().trim().min(1).max(2_000))
      .min(1, 'ogni task ha almeno un criterio di accettazione'),
  })
  .strict();

const milestoneSchema = z
  .object({
    id: keySchema,
    title: z.string().trim().min(1).max(200).optional(),
    tasks: z.array(taskSchema).min(1),
  })
  .strict();

export const planSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(5_000),
    /** Branch the mission starts from and the PR targets; omitted, the one read at creation. */
    baseBranch: z.string().trim().min(1).max(255).optional(),
    scope: z
      .object({
        dependencies: z.array(z.string().trim().min(1)).default([]),
        migrations: z.boolean().default(false),
        paths: z.array(relativePathSchema).default([]),
        /** Files a task's implementer may not change (fixtures, helpers). */
        tests: z.array(relativePathSchema).default([]),
      })
      .strict()
      .prefault({}),
    checks: z
      .object({
        setup: commandSchema.optional(),
        build: commandSchema.optional(),
        lint: commandSchema.optional(),
        test: commandSchema,
        /** Appended to `test` by `run_checks`; must carry `{{pattern}}`. */
        testFilter: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .refine(
            (filter) => filter.includes(TEST_PATTERN_MARKER),
            `deve contenere ${TEST_PATTERN_MARKER}`,
          )
          .optional(),
        /** Names of vault secrets exposed to the commands, never to the logs. */
        secrets: z
          .array(
            z
              .string()
              .regex(
                /^[A-Za-z_][A-Za-z0-9_]{0,63}$/,
                'lettere, cifre e _, non inizia con una cifra',
              ),
          )
          .default([]),
        /** Checks of the same project never run together: fixed ports, a shared dev database. */
        parallel: z.boolean().default(false),
        // Each command may carry its own workdir; this one is the default.
        workdir: relativePathSchema.optional(),
      })
      .strict(),
    team: z
      .object({
        orchestrator: modelSchema,
        roles: z.record(roleName, roleSchema),
        custom: z.array(customAgentSchema).default([]),
      })
      .strict(),
    budget: z
      .object({
        fiveHourMinRemaining: z.number().min(0).max(1).default(0.1),
        weeklyMaxShare: z.number().min(0).max(1).default(0.3),
      })
      .strict()
      .prefault({}),
    parallelTasks: z.number().int().min(1).max(20).default(1),
    milestones: z.array(milestoneSchema).min(1),
  })
  .strict();

export type Plan = z.infer<typeof planSchema>;
export type PlanTask = z.infer<typeof taskSchema>;
export type PlanMilestone = z.infer<typeof milestoneSchema>;

/** All the tasks of the plan, in order, with the id of their milestone. */
export function planTasks(plan: Plan) {
  return plan.milestones.flatMap((m) =>
    m.tasks.map((task) => ({ ...task, milestone: m.id })),
  );
}

/** The command as a string, whichever form it has. */
export function commandText(command: z.infer<typeof commandSchema>) {
  return typeof command === 'string' ? command : command.run;
}

/** JSON with object keys sorted, to compare two plans by content. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}
