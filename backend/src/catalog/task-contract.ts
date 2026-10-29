import type { GraphStep } from './workflow-graph.js';

/** For each step, the steps it depends on directly or indirectly. */
function ancestors(steps: GraphStep[]) {
  const result = new Map<string, Set<string>>();
  // Steps are already sorted by `sortSteps` when this runs.
  for (const step of steps) {
    const all = new Set<string>();
    for (const need of step.needs) {
      all.add(need);
      for (const a of result.get(need) ?? []) all.add(a);
    }
    result.set(step.id, all);
  }
  return result;
}

/**
 * What is wrong with a task model's contract (§6.2, rules 1-6), each as
 * `passo <id>, <campo>: …`; empty when it holds. The graph itself must have
 * passed `graphErrors` first.
 */
export function taskContractErrors(
  steps: GraphStep[],
  resultId: string | undefined,
): string[] {
  const errors: string[] = [];
  if (!resultId) return ['result: manca il passo che chiude il task'];
  const byId = new Map(steps.map((s) => [s.id, s]));
  const result = byId.get(resultId);
  if (!result) return [`result: passo sconosciuto "${resultId}"`];

  // 1. result is a step with a verdict that contains ok, and has no successors.
  if (!result.verdict?.includes('ok')) {
    errors.push(`passo ${result.id}, verdict: deve contenere "ok"`);
  }
  const successors = steps.filter((s) => s.needs.includes(result.id));
  if (successors.length) {
    errors.push(
      `passo ${result.id}, result: non può avere successori (${successors.map((s) => s.id).join(', ')})`,
    );
  }

  // 2. result runs commands and is judged by an agent.
  if (!result.run?.length) {
    errors.push(`passo ${result.id}, run: la verifica finale deve eseguire i controlli`);
  }
  if (!result.agent) {
    errors.push(`passo ${result.id}, agent: la verifica finale deve avere un revisore`);
  }

  // 3. Every step with an agent is before result, or inside its repeat block.
  const above = ancestors(steps);
  const repeating = steps.find((s) => s.repeat?.with === result.id);
  for (const step of steps) {
    if (!step.agent || step.id === result.id) continue;
    const inBlock = step.id === repeating?.id;
    if (!above.get(result.id)?.has(step.id) && !inBlock) {
      errors.push(
        `passo ${step.id}: con un agente deve venire prima di ${result.id} o essere il passo che ripete su ${result.id}`,
      );
    }
  }

  // 4. The judge is not one of the writers.
  if (result.agent) {
    const writers = steps
      .filter((s) => s.id !== result.id && s.agent)
      .map((s) => s.agent);
    if (writers.includes(result.agent)) {
      errors.push(
        `passo ${result.id}, agent: chi giudica non può essere anche chi scrive (${result.agent})`,
      );
    }
  }

  // 5. At most three attempts; 6. stop verdicts belong to result and aren't ok.
  for (const step of steps) {
    if (step.repeat && step.repeat.max > 3) {
      errors.push(`passo ${step.id}, repeat.max: al massimo 3 nei modelli di task`);
    }
    for (const stop of step.repeat?.stop ?? []) {
      if (stop === 'ok') {
        errors.push(`passo ${step.id}, repeat.stop: "ok" non può fermare il repeat`);
      } else if (!result.verdict?.includes(stop)) {
        errors.push(
          `passo ${step.id}, repeat.stop: "${stop}" non è tra i verdetti di ${result.id}`,
        );
      }
    }
  }
  return errors;
}
