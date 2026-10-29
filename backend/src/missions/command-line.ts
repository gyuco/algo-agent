/**
 * Commands of the plan are not shell lines: they become an argument vector for
 * `spawn` with `shell: false`. This tokenizer is the only reading of them, in
 * validation and in `ChecksService`, so what is approved is what runs.
 */
export class CommandLineError extends Error {}

/** What a filter of `checks.testFilter` may contain. */
export const TEST_PATTERN = /^[A-Za-z0-9_./*:@-]{1,200}$/;

/** The marker `checks.testFilter` must carry, replaced by the pattern. */
export const TEST_PATTERN_MARKER = '{{pattern}}';

const HINT =
  'I comandi non passano da una shell: usa workdir per cambiare cartella, e metti più comandi in uno script di package.json.';

const unquoted = (char: string): never => {
  throw new CommandLineError(
    `Il comando usa l'operatore di shell "${char}". ${HINT}`,
  );
};

/**
 * Splits a command as written in the plan into arguments: spaces separate,
 * `'…'` and `"…"` quote (with `\` escaping inside double quotes), and empty
 * quoted arguments survive. Shell operators are refused outside quotes.
 */
export function parseCommand(text: string): string[] {
  const argv: string[] = [];
  let current = '';
  let started = false;
  let i = 0;

  const push = () => {
    if (!started) return;
    argv.push(current);
    current = '';
    started = false;
  };

  while (i < text.length) {
    const char = text[i];

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      push();
      i++;
      continue;
    }

    if (char === "'") {
      started = true;
      const end = text.indexOf("'", i + 1);
      if (end < 0)
        throw new CommandLineError(`Virgolette non chiuse in "${text}"`);
      current += text.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (char === '"') {
      started = true;
      i++;
      let closed = false;
      while (i < text.length) {
        const inner = text[i];
        if (inner === '\\') {
          const next = text[i + 1];
          if (next === undefined) break;
          current += next;
          i += 2;
          continue;
        }
        if (inner === '"') {
          closed = true;
          i++;
          break;
        }
        current += inner;
        i++;
      }
      if (!closed)
        throw new CommandLineError(`Virgolette non chiuse in "${text}"`);
      continue;
    }

    // Outside quotes only: everything a shell would interpret is refused.
    if (
      char === '&' ||
      char === '|' ||
      char === ';' ||
      char === '>' ||
      char === '<'
    ) {
      unquoted(char === '|' || char === '&' ? text.slice(i, i + 2) : char);
    }
    if (char === '`' || char === '$' || char === '*') unquoted(char);
    if (char === '~' && !started) {
      throw new CommandLineError(
        `Il comando usa "~", che una shell espanderebbe. ${HINT}`,
      );
    }

    current += char;
    started = true;
    i++;
  }

  push();
  if (!argv.length) throw new CommandLineError('Il comando è vuoto');
  return argv;
}

/** The arguments `checks.testFilter` adds after the `test` command. */
export function testFilterArgs(filter: string, pattern: string): string[] {
  return parseCommand(filter).map((arg) =>
    arg.includes(TEST_PATTERN_MARKER)
      ? arg.split(TEST_PATTERN_MARKER).join(pattern)
      : arg,
  );
}

/** Whether a `run_checks` pattern is acceptable. */
export function validTestPattern(pattern: string) {
  return TEST_PATTERN.test(pattern);
}
