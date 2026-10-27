import {
  APP_SERVER,
  toolCallViolation,
  type AgentPolicy,
} from '../agents/policy.js';

/** A rule of an OpenCode permission ruleset; the last rule matching a call wins. */
export interface PermissionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

/** What OpenCode sends when a tool call reaches an `ask` rule. */
export interface PermissionRequest {
  id: string;
  action: string;
  /** Paths for read/edit, the pattern for glob/grep, the skill id for skill. */
  resources: string[];
  metadata?: { root?: unknown; path?: unknown };
}

const READ_ACTIONS = ['read', 'glob', 'grep'];
/** OpenCode's write tool asks for `edit` too. */
const WRITE_ACTIONS = ['edit'];

/**
 * OpenCode names an MCP tool `<server>_<tool>` and asks permission under that
 * name. Catalog servers get a prefix so their tools can't pass for a built-in
 * action (`external_directory` from a server called `external`); keys have no
 * `_`, so the first one ends the server name.
 */
export function mcpServerName(key: string) {
  return `mcp-${key}`;
}
const MCP_ACTION = /^mcp-([a-z0-9][a-z0-9-]*)_(.+)$/;
const APP_ACTION = new RegExp(`^${APP_SERVER}_(.+)$`);

/**
 * Everything is denied (no shell, web, subagents, code mode, or paths outside
 * the project) except what the policy grants, which asks: each call then comes
 * back to the app, which checks it like a Claude Code tool call.
 */
export function permissionRules(policy: AgentPolicy): PermissionRule[] {
  const actions = [
    ...(policy.files === 'none' ? [] : READ_ACTIONS),
    ...(policy.files === 'write' ? WRITE_ACTIONS : []),
    ...(policy.tools.length ? [`${APP_SERVER}_*`] : []),
    ...policy.mcp.map((key) => `${mcpServerName(key)}_*`),
    ...(policy.skills.length ? ['skill'] : []),
  ];
  return [
    { action: '*', resource: '*', effect: 'deny' },
    ...actions.map((action): PermissionRule => ({
      action,
      resource: '*',
      effect: 'ask',
    })),
  ];
}

const text = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined;

/** The request as the Claude Code tool call it amounts to, so one policy check covers both runtimes. */
function asToolCalls(
  request: PermissionRequest,
): [string, Record<string, unknown>][] {
  const root = text(request.metadata?.root);
  switch (request.action) {
    case 'read':
      return request.resources.map((path) => ['Read', { path }]);
    case 'edit':
      return request.resources.map((path) => ['Edit', { path }]);
    case 'glob':
      return request.resources.map((pattern) => [
        'Glob',
        { path: root, pattern },
      ]);
    case 'grep':
      return [['Grep', { path: text(request.metadata?.path) ?? root }]];
    case 'skill':
      return request.resources.map((skill) => ['Skill', { skill }]);
  }
  const mcp = MCP_ACTION.exec(request.action);
  if (mcp) return [[`mcp__${mcp[1]}__${mcp[2]}`, {}]];
  const app = APP_ACTION.exec(request.action);
  if (app) return [[`mcp__${APP_SERVER}__${app[1]}`, {}]];
  return [[request.action, {}]];
}

/** Why the request must be rejected under `policy`, or null when it is allowed. */
export async function permissionViolation(
  cwd: string,
  policy: AgentPolicy,
  request: PermissionRequest,
): Promise<string | null> {
  for (const [tool, input] of asToolCalls(request)) {
    const reason = await toolCallViolation(cwd, policy, tool, input);
    if (reason) return reason;
  }
  return null;
}
