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
/** OpenCode's tool, and permission action, for running a subagent in a child session. */
export const SUBAGENT_ACTION = 'subagent';
const SUBAGENT_PREFIX = 'agent_';
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

/**
 * A catalog agent's id as an OpenCode subagent. The prefix keeps it apart
 * from OpenCode's own agents (`general`, `explore`…), whose built-in
 * permissions would otherwise be merged in, and from the app's main agent;
 * keys have no `_`, so no catalog key can produce another one's id.
 */
export function subagentId(key: string) {
  return `${SUBAGENT_PREFIX}${key}`;
}

/** The catalog key of a subagent id, or null for any other agent. */
export function subagentKey(id: string): string | null {
  return id.startsWith(SUBAGENT_PREFIX)
    ? id.slice(SUBAGENT_PREFIX.length)
    : null;
}
const APP_ACTION = new RegExp(`^${APP_SERVER}_(.+)$`);

/**
 * Everything is denied (no shell, web, code mode, paths outside the project,
 * or subagents other than `delegates`) except what the policy grants, which
 * asks: each call then comes back to the app, which checks it like a Claude
 * Code tool call. Only the subagents asked for by name are offered to the
 * model, so OpenCode's own don't show up.
 */
export function permissionRules(
  policy: AgentPolicy,
  delegates: string[] = [],
): PermissionRule[] {
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
    ...delegates.map((key): PermissionRule => ({
      action: SUBAGENT_ACTION,
      resource: subagentId(key),
      effect: 'ask',
    })),
  ];
}

/**
 * Why a request to run a subagent must be rejected, or null when the main
 * thread may delegate to every agent it names. Subagents can't delegate.
 */
export function delegationViolation(
  delegates: string[],
  fromSubagent: boolean,
  request: PermissionRequest,
): string | null {
  if (fromSubagent) return 'Un agente delegato non può delegare a sua volta';
  const unknown = request.resources.find((id) => {
    const key = subagentKey(id);
    return !key || !delegates.includes(key);
  });
  return unknown === undefined && request.resources.length
    ? null
    : `L'agente ${unknown ?? '?'} non è disponibile in questo progetto`;
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
