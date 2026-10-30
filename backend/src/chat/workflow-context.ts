import type { Run } from '../generated/prisma/client.js';
import { listSteps, readSteps } from '../runs/run-steps.js';

/** A step's answer gets this much of the turn; the whole context, `MAX_TOTAL`. */
const MAX_STEP = 6_000;
const MAX_TOTAL = 30_000;

const OPEN = (id: number) => `<workflow-run id="${id}">`;
const CLOSE = '</workflow-run>';
/** The blocks `workflowContext` appends, with whatever comes before them. */
const BLOCK = /\s*<workflow-run id="(\d+)">[\s\S]*?<\/workflow-run>/g;

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n[…]` : text;

/** Keeps an answer from closing its block early. */
const escape = (text: string) => text.replaceAll(CLOSE, '</workflow-run >');

/**
 * What the workflows run in a conversation since its last turn did, appended
 * to the user's message so the model knows of them: their steps ran in
 * sessions of their own. After the message, so the conversation keeps its title.
 */
export function workflowContext(runs: Run[]): string {
  let room = MAX_TOTAL;
  return runs
    .map((run) => {
      const steps = listSteps(readSteps(run.stepsJson)).map((step) => {
        const head = [
          `## ${step.id} (${step.agent}${step.model ? `, ${step.model}` : ''})`,
          `status: ${step.status}`,
          step.verdict && `verdict: ${step.verdict}`,
        ].filter(Boolean);
        const output = cut(step.output, Math.min(MAX_STEP, room));
        room = Math.max(room - output.length, 0);
        return [...head, '', escape(output)].join('\n');
      });
      return [
        OPEN(run.id),
        `Before this message the user ran the workflow "${run.workflow}" in this conversation. Its steps ran as separate agent sessions; this is what they did, for context.`,
        `Input: ${escape(run.input)}`,
        `Outcome: ${run.status}${run.error ? ` (${escape(run.error)})` : ''}`,
        '',
        ...steps,
        CLOSE,
      ].join('\n');
    })
    .join('\n\n');
}

/** The user's own text of a message, and the workflow runs whose context it carried. */
export function stripWorkflowContext(text: string): {
  text: string;
  runIds: number[];
} {
  const runIds = [...text.matchAll(BLOCK)].map((m) => Number(m[1]));
  return runIds.length
    ? { text: text.replace(BLOCK, '').trimEnd(), runIds }
    : { text, runIds };
}
