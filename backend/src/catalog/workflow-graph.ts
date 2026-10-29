/** A workflow step as written: `id` and `needs` may be left out. */
export interface StepSpec {
  id?: string;
  /** A catalog agent, or `role:<role>` in a task model. Absent in a run-only step. */
  agent?: string;
  prompt?: string;
  needs?: string[];
  approval?: boolean;
  verdict?: string[];
  /** Shell commands of the plan to run, by name. Task models only. */
  run?: string[];
  /** Whether the commands must pass or fail. Default `pass`. */
  expect?: 'pass' | 'fail';
  /** Steps whose files this one may not change. Task models only. */
  protect?: string[];
  repeat?: Repeat;
}

/** The step runs, then its check `with`, until the check's verdict is `until`, at most `max` times. */
export interface Repeat {
  with: string;
  until: string;
  max: number;
  /** At `max` without `until`: the run fails, or goes on with a warning. */
  onMax?: 'fail' | 'continue';
  /** Verdicts that end the block at once. Task models only. */
  stop?: string[];
}

/** A step with its defaults filled in. */
export interface GraphStep {
  id: string;
  /** Empty in a run-only step; task models resolve `role:` when the plan is executed. */
  agent: string;
  /** Empty in a run-only step. */
  prompt: string;
  needs: string[];
  approval: boolean;
  verdict: string[] | null;
  run: string[] | null;
  expect: 'pass' | 'fail';
  protect: string[];
  repeat: (Required<Omit<Repeat, 'stop'>> & { stop: string[] }) | null;
}

const STEP_REF = /\{\{steps\.([^}]*)\}\}/g;

/** What `{{steps.<check>}}` says in a repeated step before the check ran once. */
export const NO_CHECK_YET = '(nessuna verifica ancora)';

/** The ids a prompt refers to with `{{steps.<id>}}`. */
export const stepRefs = (prompt: string) =>
  [...prompt.matchAll(STEP_REF)].map((m) => m[1]);

/**
 * Fills the defaults: a step without `id` is `step-<n>`, from 1; one without
 * `needs` depends on the step before it, so a plain list is the chain it always was.
 */
export function normalizeSteps(steps: StepSpec[]): GraphStep[] {
  const ids = steps.map((s, i) => s.id ?? `step-${i + 1}`);
  return steps.map((s, i) => ({
    id: ids[i],
    agent: s.agent ?? '',
    prompt: s.prompt ?? '',
    needs: s.needs ?? (i === 0 ? [] : [ids[i - 1]]),
    approval: s.approval ?? false,
    verdict: s.verdict ?? null,
    run: s.run ?? null,
    expect: s.expect ?? 'pass',
    protect: s.protect ?? [],
    repeat: s.repeat
      ? { onMax: 'fail', stop: [], ...s.repeat }
      : null,
  }));
}

/** The checks of the steps that repeat, each with the step it checks. */
export function checksOf(steps: GraphStep[]) {
  const checks = new Map<string, GraphStep>();
  for (const step of steps) {
    if (step.repeat) checks.set(step.repeat.with, step);
  }
  return checks;
}

/**
 * The steps in an order where each comes after the ones it needs, keeping the
 * list order where the graph allows; null when the dependencies form a cycle.
 */
export function sortSteps(steps: GraphStep[]): GraphStep[] | null {
  const sorted: GraphStep[] = [];
  const placed = new Set<string>();
  const left = [...steps];
  while (left.length) {
    const next = left.findIndex((s) => s.needs.every((n) => placed.has(n)));
    if (next < 0) return null;
    const [step] = left.splice(next, 1);
    sorted.push(step);
    placed.add(step.id);
  }
  return sorted;
}

/** For each step, the steps it depends on directly or indirectly. */
function ancestors(sorted: GraphStep[]) {
  const result = new Map<string, Set<string>>();
  for (const step of sorted) {
    const all = new Set<string>();
    for (const need of step.needs) {
      all.add(need);
      for (const a of result.get(need) ?? []) all.add(a);
    }
    result.set(step.id, all);
  }
  return result;
}

/** What is wrong with a step's `repeat` and its check. */
function repeatErrors(
  step: GraphStep,
  byId: Map<string, GraphStep>,
  checks: Map<string, GraphStep>,
): string[] {
  const { with: id, until } = step.repeat!;
  const at = `passo ${step.id}, repeat`;
  const check = byId.get(id);
  if (!check) return [`${at}.with: passo sconosciuto "${id}"`];
  if (check.id === step.id)
    return [`${at}.with: non può essere il passo stesso`];
  const errors: string[] = [];
  if (check.needs.length !== 1 || check.needs[0] !== step.id) {
    errors.push(`${at}.with: la verifica deve dipendere solo da ${step.id}`);
  }
  if (!check.verdict) {
    errors.push(`${at}.with: la verifica deve dichiarare verdict`);
  } else if (!check.verdict.includes(until)) {
    errors.push(`${at}.until: "${until}" non è tra i verdetti di ${id}`);
  }
  if (checks.get(id) !== step) {
    errors.push(`${at}.with: ${id} è già la verifica di un altro passo`);
  }
  if (check.repeat) errors.push(`${at}.with: la verifica non può avere repeat`);
  if (check.approval) {
    errors.push(`${at}.with: la verifica non può chiedere approvazione`);
  }
  if (checks.has(step.id)) {
    errors.push(
      `${at}: un passo che è la verifica di un altro non può ripetersi`,
    );
  }
  return errors;
}

/**
 * What is wrong with the steps' graph, each as `passo <id>, <campo>: …` so the
 * editor can show it next to the field; empty when the graph is valid.
 */
export function graphErrors(steps: GraphStep[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) errors.push(`passo ${step.id}, id: duplicato`);
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const need of step.needs) {
      if (!ids.has(need)) {
        errors.push(`passo ${step.id}, needs: passo sconosciuto "${need}"`);
      } else if (need === step.id) {
        errors.push(`passo ${step.id}, needs: dipende da sé stesso`);
      }
    }
    if (new Set(step.needs).size !== step.needs.length) {
      errors.push(`passo ${step.id}, needs: passi ripetuti`);
    }
  }
  if (errors.length) return errors;

  const sorted = sortSteps(steps);
  if (!sorted) return ['needs: le dipendenze formano un ciclo'];
  const above = ancestors(sorted);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const checks = checksOf(steps);

  for (const step of steps) {
    if (step.verdict && new Set(step.verdict).size !== step.verdict.length) {
      errors.push(`passo ${step.id}, verdict: valori ripetuti`);
    }
    if (step.repeat) errors.push(...repeatErrors(step, byId, checks));
  }
  for (const step of steps) {
    const check = step.repeat?.with;
    for (const ref of stepRefs(step.prompt)) {
      if (!ids.has(ref)) {
        errors.push(`passo ${step.id}, prompt: {{steps.${ref}}} non esiste`);
      } else if (!above.get(step.id)?.has(ref) && ref !== check) {
        errors.push(
          `passo ${step.id}, prompt: {{steps.${ref}}} non è tra le dipendenze del passo`,
        );
      }
    }
    // With no dependency it stays empty, as for the first step of a chain.
    if (step.prompt.includes('{{previous}}') && step.needs.length > 1) {
      errors.push(
        `passo ${step.id}, prompt: {{previous}} vale solo con una dipendenza; usa {{steps.<id>}}`,
      );
    }
    if (
      step.prompt.includes('{{iteration}}') &&
      !step.repeat &&
      !checks.has(step.id)
    ) {
      errors.push(
        `passo ${step.id}, prompt: {{iteration}} vale solo in un passo con repeat o nella sua verifica`,
      );
    }
  }
  return errors;
}

/**
 * The step's prompt with its variables: `{{input}}` the user's text (or
 * `{{task}}` in a task model), `{{steps.<id>}}` that step's output,
 * `{{previous}}` the output of its only dependency, `{{iteration}}` the round
 * of a repeat, from 1.
 */
export function fillPrompt(
  step: GraphStep,
  input: string,
  outputs: Record<string, string>,
  iteration?: number,
) {
  const previous = step.needs.length === 1 ? outputs[step.needs[0]] : '';
  return step.prompt
    .replace(STEP_REF, (_, id: string) => outputs[id] ?? '')
    .replaceAll('{{input}}', input)
    .replaceAll('{{task}}', input)
    .replaceAll('{{previous}}', previous ?? '')
    .replaceAll('{{iteration}}', String(iteration ?? ''));
}
