import {
  createSdkMcpServer,
  type AgentDefinition,
  type McpServerConfig,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { Logger } from '@nestjs/common';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  APP_SERVER,
  READ_TOOLS,
  SKILLS_PLUGIN,
  WRITE_TOOLS,
  builtinTools,
  toolCallViolation,
  type AgentPolicy,
} from '../agents/policy.js';
import type { Catalog, McpSpec, SkillSpec } from '../catalog/catalog.js';
import { interpolate, skillFile } from '../catalog/runtime.js';
import { IMAGE_TYPES } from '../chat/dto/chat.dto.js';
import type { ChatEvent, Subagent, UserTurn } from '../providers/provider.js';
import { toRateLimitSnapshot } from './rate-limit.js';

/** Provider id of Claude Code. */
export const CLAUDE = 'claude';

function mcpConfig(spec: McpSpec): McpServerConfig {
  return spec.type === 'stdio'
    ? {
        type: 'stdio',
        command: spec.command,
        args: spec.args,
        env: interpolate(spec.env, spec.key),
        alwaysLoad: true,
      }
    : {
        type: 'http',
        url: spec.url,
        headers: interpolate(spec.headers, spec.key),
        alwaysLoad: true,
      };
}

/**
 * Writes the skills as a Claude Code plugin in a fresh folder under `parent`,
 * for one run; the caller removes it afterwards.
 */
export async function skillsPlugin(parent: string, skills: SkillSpec[]) {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(parent, 'skills-'));
  await mkdir(join(dir, '.claude-plugin'));
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: SKILLS_PLUGIN, version: '0.0.0' }),
  );
  for (const skill of skills) {
    await mkdir(join(dir, 'skills', skill.key), { recursive: true });
    await writeFile(
      join(dir, 'skills', skill.key, 'SKILL.md'),
      skillFile(skill),
    );
  }
  return dir;
}

/** Claude Code's tool for handing a task to a subagent (called Task before). */
export const AGENT_TOOLS = ['Agent', 'Task'];

/**
 * What a subagent must not use: whatever the main thread has and its own
 * policy doesn't grant, and further delegation. Enforced again on every call
 * by `confine`; this only keeps the rest out of the subagent's sight.
 */
function subagentDisallowed(main: AgentPolicy, own: AgentPolicy): string[] {
  const builtins = builtinTools(own);
  return [
    ...AGENT_TOOLS,
    ...[...READ_TOOLS, ...WRITE_TOOLS, 'Skill'].filter(
      (t) => !builtins.includes(t),
    ),
    ...main.tools
      .filter((k) => !own.tools.includes(k))
      .map((k) => `mcp__${APP_SERVER}__${k}`),
    ...main.mcp.filter((k) => !own.mcp.includes(k)).map((k) => `mcp__${k}`),
  ];
}

/** The agents the main thread may delegate to, as Claude Code subagents. */
export function subagentDefinitions(
  main: AgentPolicy,
  subagents: Subagent[],
): Record<string, AgentDefinition> {
  return Object.fromEntries(
    subagents.map((s) => [
      s.agent.key,
      {
        description: s.agent.description,
        prompt: s.systemPrompt,
        model: s.model ?? 'inherit',
        maxTurns: s.agent.maxTurns ?? 20,
        disallowedTools: subagentDisallowed(main, s.policy),
        background: false,
      },
    ]),
  );
}

/** Tools, MCP servers and skills the policy grants, and nothing else. */
export function capabilities(
  catalog: Catalog,
  policy: AgentPolicy,
  cwd: string,
  pluginDir: string | null,
  subagents: Subagent[] = [],
): Pick<Options, 'tools' | 'mcpServers' | 'skills' | 'plugins' | 'agents'> {
  const mcpServers: Record<string, McpServerConfig> = {};
  if (policy.tools.length) {
    mcpServers[APP_SERVER] = createSdkMcpServer({
      name: APP_SERVER,
      tools: policy.tools.map((k) => catalog.tools.get(k)!.create({ cwd })),
      alwaysLoad: true,
    });
  }
  for (const key of policy.mcp) {
    mcpServers[key] = mcpConfig(catalog.mcp.get(key)!);
  }
  return {
    tools: [...builtinTools(policy), ...(subagents.length ? ['Agent'] : [])],
    agents: subagentDefinitions(policy, subagents),
    mcpServers,
    skills: policy.skills.map((k) => `${SKILLS_PLUGIN}:${k}`),
    plugins: pluginDir
      ? [{ type: 'local', path: pluginDir, skipMcpDiscovery: true }]
      : [],
  };
}

/**
 * Why a delegation must be denied, or null when the main thread may hand the
 * task to that agent. Subagents can't delegate further.
 */
function delegationViolation(
  subagents: Subagent[],
  fromSubagent: boolean,
  input: Record<string, unknown>,
): string | null {
  if (fromSubagent) return 'Un agente delegato non può delegare a sua volta';
  const type = input.subagent_type;
  return subagents.some((s) => s.agent.key === type)
    ? null
    : `L'agente ${typeof type === 'string' ? type : '?'} non è disponibile in questo progetto`;
}

/**
 * Enforces the policies on every tool call: the main thread's, or the
 * subagent's own when the call comes from one. The PreToolUse hook runs for
 * every call, including ones Claude Code would auto-approve (such as reads
 * outside `cwd`); `canUseTool` covers calls that reach a permission prompt.
 */
export function confine(
  cwd: string,
  policy: AgentPolicy,
  logger: Logger,
  subagents: Subagent[] = [],
): Pick<Options, 'hooks' | 'canUseTool'> {
  /** Subagent types by agent id, as Claude Code starts them. */
  const running = new Map<string, string>();
  const policyOf = (agentId: string | undefined) => {
    if (!agentId) return policy;
    const type = running.get(agentId);
    return subagents.find((s) => s.agent.key === type)?.policy;
  };
  const violation = async (
    tool: string,
    input: unknown,
    agentId: string | undefined,
  ) => {
    const args = (input ?? {}) as Record<string, unknown>;
    if (AGENT_TOOLS.includes(tool)) {
      return delegationViolation(subagents, Boolean(agentId), args);
    }
    const own = policyOf(agentId);
    // Fail closed: a subagent the app didn't define gets nothing.
    if (!own) return 'Agente sconosciuto';
    return toolCallViolation(cwd, own, tool, args);
  };
  return {
    hooks: {
      SubagentStart: [
        {
          hooks: [
            async (input) => {
              if (input.hook_event_name === 'SubagentStart') {
                running.set(input.agent_id, input.agent_type);
              }
              return {};
            },
          ],
        },
      ],
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              if (input.hook_event_name !== 'PreToolUse') return {};
              const reason = await violation(
                input.tool_name,
                input.tool_input,
                input.agent_id,
              );
              if (!reason) {
                if (!AGENT_TOOLS.includes(input.tool_name)) return {};
                // Wait for the agent: the turn must not end while it still works.
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                    updatedInput: {
                      ...(input.tool_input as Record<string, unknown>),
                      run_in_background: false,
                    },
                  },
                };
              }
              logger.warn(`Denied ${input.tool_name}: ${reason}`);
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: reason,
                },
              };
            },
          ],
        },
      ],
    },
    canUseTool: async (tool, input, { agentID }) => {
      const reason = await violation(tool, input, agentID);
      return reason
        ? { behavior: 'deny', message: reason }
        : { behavior: 'allow', updatedInput: input };
    },
  };
}

type UserContent = Exclude<SDKUserMessage['message']['content'], string>;

/** One Messages API content block per attachment, then the typed text. */
function userContent(turn: UserTurn): UserContent {
  const blocks: UserContent = turn.attachments.map((a) => {
    if ((IMAGE_TYPES as readonly string[]).includes(a.mediaType)) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: a.mediaType as (typeof IMAGE_TYPES)[number],
          data: a.data,
        },
      };
    }
    if (a.mediaType === 'application/pdf') {
      return {
        type: 'document',
        title: a.name,
        source: { type: 'base64', media_type: 'application/pdf', data: a.data },
      };
    }
    return {
      type: 'document',
      title: a.name,
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: Buffer.from(a.data, 'base64').toString('utf8'),
      },
    };
  });
  if (turn.text) blocks.push({ type: 'text', text: turn.text });
  return blocks;
}

/** A single user turn in streaming-input form, the only form that carries attachments. */
async function* singleTurn(
  content: UserContent,
): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
}

/** The turn as Claude Code's prompt: plain text unless it carries attachments. */
export function sdkPrompt(
  turn: UserTurn,
): string | AsyncIterable<SDKUserMessage> {
  return turn.attachments.length ? singleTurn(userContent(turn)) : turn.text;
}

/** What `toEvents` remembers across one turn's messages. */
export interface TurnState {
  /** Threads that already wrote text: '' for the main one, else the delegation id. */
  wroteText: Set<string>;
  /** Delegations started and not yet finished. */
  delegations: Set<string>;
}

export function turnState(): TurnState {
  return { wroteText: new Set(), delegations: new Set() };
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** Where the target of a tool call is, for the chat to show. */
export function toolTarget(input: Record<string, unknown>) {
  const target = input.file_path ?? input.pattern ?? input.path ?? null;
  return typeof target === 'string' ? target : null;
}

/** Chat events for one Claude Code message. */
export function* toEvents(
  message: SDKMessage,
  state: TurnState,
): Generator<ChatEvent> {
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init') {
        yield {
          type: 'session',
          provider: CLAUDE,
          sessionId: message.session_id,
          model: message.model,
        };
      }
      return;
    case 'stream_event': {
      // A subagent's text comes whole, with its assistant messages.
      if (message.parent_tool_use_id) return;
      const { event } = message;
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'text' &&
        state.wroteText.has('')
      ) {
        yield { type: 'text', text: '\n\n' };
      }
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        state.wroteText.add('');
        yield { type: 'text', text: event.delta.text };
      }
      return;
    }
    case 'assistant': {
      const delegation = message.parent_tool_use_id ?? undefined;
      if (message.error) {
        yield { type: 'error', message: `Claude Code: ${message.error}` };
      }
      for (const block of message.message.content) {
        if (block.type === 'text' && delegation && block.text) {
          if (state.wroteText.has(delegation)) {
            yield { type: 'text', text: '\n\n', delegation };
          }
          state.wroteText.add(delegation);
          yield { type: 'text', text: block.text, delegation };
        }
        if (block.type !== 'tool_use') continue;
        const input = block.input as Record<string, unknown>;
        if (!delegation && AGENT_TOOLS.includes(block.name)) {
          state.delegations.add(block.id);
          yield {
            type: 'delegation',
            id: block.id,
            agent: text(input.subagent_type),
            description: text(input.description),
            prompt: text(input.prompt),
          };
          continue;
        }
        yield {
          type: 'tool',
          name: block.name,
          target: toolTarget(input),
          ...(delegation && { delegation }),
        };
      }
      return;
    }
    case 'user': {
      // A delegation ends when its result reaches the main thread.
      const { content } = message.message;
      if (message.parent_tool_use_id || typeof content === 'string') return;
      for (const block of content) {
        if (
          block.type === 'tool_result' &&
          state.delegations.delete(block.tool_use_id)
        ) {
          yield {
            type: 'delegation_done',
            id: block.tool_use_id,
            isError: block.is_error ?? false,
          };
        }
      }
      return;
    }
    case 'rate_limit_event':
      yield {
        type: 'usage',
        provider: CLAUDE,
        details: { rateLimits: toRateLimitSnapshot(message.rate_limit_info) },
      };
      return;
    case 'result':
      // Whatever didn't report back by now won't: close it.
      for (const id of state.delegations) {
        yield { type: 'delegation_done', id, isError: true };
      }
      state.delegations.clear();
      yield {
        type: 'done',
        isError: message.is_error,
        costUsd: message.total_cost_usd,
        durationMs: message.duration_ms,
        turns: message.num_turns,
      };
      return;
  }
}
