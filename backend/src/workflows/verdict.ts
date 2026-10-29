/** Markdown an agent may wrap the line in; underscores inside a value are part of it. */
const DECORATION = /[*`]/g;
const EDGES = /^[\s*_]+|[\s*_]+$/g;
const VERDICT_LINE = /^\s*VERDETTO\s*:(.*)$/i;

/** Appended to the prompt of a step that declares verdicts. */
export const verdictInstruction = (values: string[]) =>
  `\n\nEnd your answer with a line of its own, "VERDETTO: <value>", where <value> is one of: ${values.join(', ')}.`;

/** Sent in the same session when the answer had no valid verdict. */
export const verdictReminder = (values: string[]) =>
  `Your answer did not end with a valid verdict. Reply with only the line "VERDETTO: <value>", where <value> is one of: ${values.join(', ')}.`;

/**
 * The verdict of an answer, from its last `VERDETTO:` line, ignoring case,
 * spaces and markdown; null when missing or not among `values`. `text` is the
 * answer without that line.
 */
export function parseVerdict(output: string, values: string[]) {
  const lines = output.split('\n');
  const clean = (line: string) =>
    line
      .replace(DECORATION, '')
      .replace(/_+VERDETTO_+/gi, 'VERDETTO')
      .replace(EDGES, '');
  const at = lines.findLastIndex((line) => VERDICT_LINE.test(clean(line)));
  if (at < 0) return { verdict: null, text: output };
  const value = VERDICT_LINE.exec(clean(lines[at]))![1]
    .trim()
    .replace(/[.!]$/, '')
    .replace(/^[*_]+|[*_]+$/g, '')
    .trim()
    .toLowerCase();
  const text = lines
    .filter((_, i) => i !== at)
    .join('\n')
    .trimEnd();
  return values.includes(value)
    ? { verdict: value, text }
    : { verdict: null, text };
}
