import { BadRequestException } from '@nestjs/common';
import type { SkillSpec } from './catalog.js';

/** Replaces `${VAR}` in an MCP server's env or headers with the server's environment; a missing variable is an error. */
export function interpolate(values: Record<string, string>, server: string) {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      v.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
        const value = process.env[name];
        if (value === undefined) {
          throw new BadRequestException(
            `MCP ${server}: variabile ${name} non impostata`,
          );
        }
        return value;
      }),
    ]),
  );
}

/** A skill as the SKILL.md file agent runtimes load. */
export function skillFile(skill: SkillSpec) {
  const frontmatter = `---\nname: ${skill.key}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n`;
  return frontmatter + skill.content;
}
