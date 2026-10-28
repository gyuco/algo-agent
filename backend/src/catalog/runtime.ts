import { BadRequestException } from '@nestjs/common';
import type { McpSpec, SkillSpec } from './catalog.js';

const VARIABLE = /\$\{([A-Za-z0-9_]+)\}/g;

/**
 * Replaces `${VAR}` in an MCP server's env or headers with the run's
 * variables (the user's and the project's secrets); a missing variable is an
 * error. Never the backend's own environment, unless the caller put it in
 * `variables`: a URL server would send it to whoever wrote the URL.
 */
export function interpolate(
  values: Record<string, string>,
  server: string,
  variables: Record<string, string>,
) {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      v.replace(VARIABLE, (_, name: string) => {
        const value = Object.hasOwn(variables, name)
          ? variables[name]
          : undefined;
        if (value === undefined) {
          throw new BadRequestException(
            `MCP ${server}: segreto ${name} non impostato`,
          );
        }
        return value;
      }),
    ]),
  );
}

/** The `${NAME}` an MCP server needs to run. */
export function variableNames(spec: McpSpec): string[] {
  const values = Object.values(spec.type === 'stdio' ? spec.env : spec.headers);
  const names = values.flatMap((v) =>
    [...v.matchAll(VARIABLE)].map((m) => m[1]),
  );
  return [...new Set(names)].sort();
}

/** A skill as the SKILL.md file agent runtimes load. */
export function skillFile(skill: SkillSpec) {
  const frontmatter = `---\nname: ${skill.key}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n`;
  return frontmatter + skill.content;
}
