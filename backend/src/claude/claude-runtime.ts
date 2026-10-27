import {
  createSdkMcpServer,
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
  SKILLS_PLUGIN,
  builtinTools,
  toolCallViolation,
  type AgentPolicy,
} from '../agents/policy.js';
import type { Catalog, McpSpec, SkillSpec } from '../catalog/catalog.js';
import { interpolate, skillFile } from '../catalog/runtime.js';
import { IMAGE_TYPES } from '../chat/dto/chat.dto.js';
import type { ChatEvent, UserTurn } from '../providers/provider.js';
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

/** Tools, MCP servers and skills the policy grants, and nothing else. */
export function capabilities(
  catalog: Catalog,
  policy: AgentPolicy,
  cwd: string,
  pluginDir: string | null,
): Pick<Options, 'tools' | 'mcpServers' | 'skills' | 'plugins'> {
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
    tools: builtinTools(policy),
    mcpServers,
    skills: policy.skills.map((k) => `${SKILLS_PLUGIN}:${k}`),
    plugins: pluginDir
      ? [{ type: 'local', path: pluginDir, skipMcpDiscovery: true }]
      : [],
  };
}

/**
 * Enforces the policy on every tool call. The PreToolUse hook runs for every
 * call, including ones Claude Code would auto-approve (such as reads outside
 * `cwd`); `canUseTool` covers calls that reach a permission prompt.
 */
export function confine(
  cwd: string,
  policy: AgentPolicy,
  logger: Logger,
): Pick<Options, 'hooks' | 'canUseTool'> {
  const violation = (tool: string, input: unknown) =>
    toolCallViolation(
      cwd,
      policy,
      tool,
      (input ?? {}) as Record<string, unknown>,
    );
  return {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              if (input.hook_event_name !== 'PreToolUse') return {};
              const reason = await violation(input.tool_name, input.tool_input);
              if (!reason) return {};
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
    canUseTool: async (tool, input) => {
      const reason = await violation(tool, input);
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

/** Chat events for one Claude Code message. */
export function* toEvents(
  message: SDKMessage,
  wroteText: () => boolean,
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
      // Subagent output is not shown in this chat.
      if (message.parent_tool_use_id) return;
      const { event } = message;
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'text' &&
        wroteText()
      ) {
        yield { type: 'text', text: '\n\n' };
      }
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield { type: 'text', text: event.delta.text };
      }
      return;
    }
    case 'assistant':
      if (message.error) {
        yield { type: 'error', message: `Claude Code: ${message.error}` };
      }
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          const input = block.input as Record<string, unknown>;
          const target = input.file_path ?? input.pattern ?? input.path ?? null;
          yield {
            type: 'tool',
            name: block.name,
            target: typeof target === 'string' ? target : null,
          };
        }
      }
      return;
    case 'rate_limit_event':
      yield {
        type: 'usage',
        provider: CLAUDE,
        details: { rateLimits: toRateLimitSnapshot(message.rate_limit_info) },
      };
      return;
    case 'result':
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
