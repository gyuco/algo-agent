import { pathViolation } from '../chat/workspace.js';

export const FILE_ACCESS = ['none', 'read', 'write'] as const;
export type FileAccess = (typeof FILE_ACCESS)[number];

/** In-process MCP server that serves the app's own tools (src/catalog/app-tools.ts). */
export const APP_SERVER = 'app';
/** Name of the plugin in catalog/plugin that ships the catalog skills. */
export const SKILLS_PLUGIN = 'catalog';

export const READ_TOOLS = ['Read', 'Glob', 'Grep'];
export const WRITE_TOOLS = ['Write', 'Edit'];

/**
 * What one agent may do in one project: the agent's own permissions narrowed
 * to the resources the project has switched on. Everything else is denied.
 */
export interface AgentPolicy {
  files: FileAccess;
  /** App tool keys, served as `mcp__app__<key>`. */
  tools: string[];
  /** MCP server keys, served as `mcp__<key>__<tool>`. */
  mcp: string[];
  /** Skill keys from the catalog plugin. */
  skills: string[];
}

/** Built-in Claude Code tools the policy turns on. No shell, ever: a command can't be confined to a folder. */
export function builtinTools(policy: AgentPolicy): string[] {
  const tools = [
    ...(policy.files === 'none' ? [] : READ_TOOLS),
    ...(policy.files === 'write' ? WRITE_TOOLS : []),
  ];
  if (policy.skills.length) tools.push('Skill');
  return tools;
}

/**
 * Why a tool call must be denied under `policy`, or null when it is allowed.
 * File tools must also stay inside `cwd`.
 */
export async function toolCallViolation(
  cwd: string,
  policy: AgentPolicy,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (READ_TOOLS.includes(toolName) || WRITE_TOOLS.includes(toolName)) {
    if (!builtinTools(policy).includes(toolName)) {
      return policy.files === 'read'
        ? 'Questo agente può solo leggere i file'
        : 'Questo agente non può accedere ai file';
    }
    return pathViolation(cwd, toolName, input);
  }
  if (toolName === 'Skill') {
    const skill = typeof input.skill === 'string' ? input.skill : '';
    const key = skill.startsWith(`${SKILLS_PLUGIN}:`)
      ? skill.slice(SKILLS_PLUGIN.length + 1)
      : skill;
    return policy.skills.includes(key)
      ? null
      : `La skill ${skill || '?'} non è consentita a questo agente`;
  }
  const mcp = /^mcp__([a-z0-9-]+)__(.+)$/.exec(toolName);
  if (mcp) {
    const [, server, tool] = mcp;
    const allowed =
      server === APP_SERVER
        ? policy.tools.includes(tool)
        : policy.mcp.includes(server);
    return allowed ? null : `${toolName} non è consentito a questo agente`;
  }
  return `${toolName} non è consentito`;
}
