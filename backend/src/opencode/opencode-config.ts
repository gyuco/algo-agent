import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpSpec } from '../catalog/catalog.js';
import { interpolate } from '../catalog/runtime.js';
import type { PermissionRule } from './opencode-policy.js';

/** Name of the agent the app defines in each run's config. */
export const APP_AGENT = 'app';

/**
 * Keys taken from the user's own OpenCode config: the providers they set up
 * and their default model. Credentials stored with `opencode auth` live in
 * OpenCode's data dir, which runs share, so they need nothing here. MCP
 * servers, plugins, agents and permissions are left out on purpose.
 */
const LOCAL_KEYS = ['provider', 'providers', 'model'];

/** JSONC to JSON: drops comments and trailing commas, leaving strings alone. */
export function stripJsonc(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      const start = i;
      for (i++; i < source.length && source[i] !== '"'; i++) {
        if (source[i] === '\\') i++;
      }
      out += source.slice(start, i + 1);
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** The user's OpenCode config folder (`$XDG_CONFIG_HOME/opencode`). */
export function userConfigDir(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
}

/** What runs keep from the user's own OpenCode config (see LOCAL_KEYS); empty without one. */
export async function localConfig(
  dir = userConfigDir(),
): Promise<Record<string, unknown>> {
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    let source: string;
    try {
      source = await readFile(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const config = JSON.parse(stripJsonc(source)) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(config).filter(([key]) => LOCAL_KEYS.includes(key)),
    );
  }
  return {};
}

export interface AgentConfig {
  system: string;
  steps: number;
  permissions: PermissionRule[];
}

/** Tools are offered to the model directly, not through OpenCode's Code Mode. */
const DIRECT = { codemode: false } as const;

/** A catalog MCP server in OpenCode's config format. */
export function mcpServer(spec: McpSpec): Record<string, unknown> {
  return spec.type === 'stdio'
    ? {
        type: 'local',
        command: [spec.command, ...spec.args],
        environment: interpolate(spec.env, spec.key),
        ...DIRECT,
      }
    : {
        type: 'remote',
        url: spec.url,
        headers: interpolate(spec.headers, spec.key),
        oauth: false,
        ...DIRECT,
      };
}

/** The app's tools, served over MCP to this run only (see AppMcpService). */
export function appToolsServer(url: string, token: string) {
  return {
    type: 'remote',
    url,
    headers: { Authorization: `Bearer ${token}` },
    oauth: false,
    ...DIRECT,
  };
}

/** Config of one run: the user's providers, the app's agent and the MCP servers it may use, nothing else. */
export function runConfig(
  local: Record<string, unknown>,
  agent?: AgentConfig,
  mcp: Record<string, Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ...local,
    ...(agent && {
      default_agent: APP_AGENT,
      agents: { [APP_AGENT]: { mode: 'primary', ...agent } },
    }),
    ...(Object.keys(mcp).length && { mcp: { servers: mcp } }),
  };
}
