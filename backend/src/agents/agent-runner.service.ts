import {
  createSdkMcpServer,
  query,
  type McpServerConfig,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentSpec,
  Catalog,
  McpSpec,
  SkillSpec,
} from '../catalog/catalog.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { ClaudeService } from '../claude/claude.service.js';
import { toRateLimitSnapshot } from '../claude/rate-limit.js';
import { resolveWorkspace } from '../chat/workspace.js';
import {
  APP_SERVER,
  SKILLS_PLUGIN,
  builtinTools,
  toolCallViolation,
  type AgentPolicy,
} from './policy.js';
import { ProjectResourcesService } from './project-resources.service.js';

export type ChatEvent =
  | { type: 'session'; sessionId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; target: string | null }
  | { type: 'usage'; rateLimits: ReturnType<typeof toRateLimitSnapshot> }
  | {
      type: 'done';
      isError: boolean;
      costUsd: number;
      durationMs: number;
      turns: number;
    }
  | { type: 'error'; message: string };

export interface RunRequest {
  userId: number;
  project: { id: number; path: string };
  agent: string;
  prompt: string | AsyncIterable<SDKUserMessage>;
  /** Claude Code session to continue. */
  sessionId?: string;
  /** Overrides the agent's model. */
  model?: string;
  signal: AbortSignal;
}

const FILE_ACCESS_PROMPT = {
  none: 'You have no access to files.',
  read: 'You can read files inside the current working directory with the Read, Glob and Grep tools, but you cannot create, change or delete files.',
  write:
    'You can read, create and edit files inside the current working directory with the Read, Glob, Grep, Write and Edit tools.',
} as const;

function systemPrompt(agent: AgentSpec, policy: AgentPolicy) {
  return [
    'You are an agent inside a small app that works on one project folder.',
    FILE_ACCESS_PROMPT[policy.files],
    'You cannot run commands or touch files outside that directory.',
    'Answer in the language the user writes in. Keep answers concise and use Markdown.',
    '',
    agent.prompt,
  ].join('\n');
}

/** Replaces `${VAR}` with the server's environment; a missing variable is an error. */
function interpolate(values: Record<string, string>, server: string) {
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
async function skillsPlugin(parent: string, skills: SkillSpec[]) {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(parent, 'skills-'));
  await mkdir(join(dir, '.claude-plugin'));
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: SKILLS_PLUGIN, version: '0.0.0' }),
  );
  for (const skill of skills) {
    await mkdir(join(dir, 'skills', skill.key), { recursive: true });
    const frontmatter = `---\nname: ${skill.key}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n`;
    await writeFile(
      join(dir, 'skills', skill.key, 'SKILL.md'),
      frontmatter + skill.content,
    );
  }
  return dir;
}

/** Runs one agent turn in a project with exactly the permissions its policy grants. */
@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);

  constructor(
    private readonly claude: ClaudeService,
    private readonly config: ConfigService,
    private readonly catalogService: CatalogService,
    private readonly resources: ProjectResourcesService,
  ) {}

  private workspaceRoot() {
    return this.config.get<string>('WORKSPACE_ROOT') || homedir();
  }

  /** The agent, if it exists and is switched on in the project, with what it may use. */
  async agentFor(userId: number, projectId: number, key: string) {
    const catalog = await this.catalogService.forUser(userId);
    const agent = catalog.agents.get(key);
    const enabled = await this.resources.isEnabled(projectId, catalog);
    if (!agent || !enabled('agent', key)) {
      throw new BadRequestException(
        `L'agente ${key} non è disponibile in questo progetto`,
      );
    }
    const policy = this.resources.policyFor(agent, enabled);
    const stdio = policy.mcp.filter(
      (k) => catalog.mcp.get(k)?.type === 'stdio',
    );
    if (stdio.length && !(await this.claude.isPersonalOwner(userId))) {
      throw new BadRequestException(
        `I server MCP stdio (${stdio.join(', ')}) girano solo in modalità personale`,
      );
    }
    return { catalog, agent, policy };
  }

  /** Yields chat events as Claude Code streams them. */
  async *run(req: RunRequest): AsyncGenerator<ChatEvent> {
    const { catalog, agent, policy } = await this.agentFor(
      req.userId,
      req.project.id,
      req.agent,
    );
    const cwd = await resolveWorkspace(req.project.path, this.workspaceRoot());
    const credential = await this.claude.credentialFor(req.userId);
    const env = await this.claude.agentEnv(req.userId, credential);
    const pluginDir = policy.skills.length
      ? await skillsPlugin(
          join(env.CLAUDE_CONFIG_DIR, 'runs'),
          policy.skills.map((k) => catalog.skills.get(k)!),
        )
      : null;
    const abortController = new AbortController();
    req.signal.addEventListener('abort', () => abortController.abort(), {
      once: true,
    });

    const session = query({
      prompt: req.prompt,
      options: {
        abortController,
        cwd,
        env,
        model: req.model ?? agent.model,
        resume: req.sessionId,
        ...this.capabilities(catalog, policy, cwd, pluginDir),
        ...this.confine(cwd, policy),
        permissionMode: 'default',
        // Don't load the workspace's own settings: they could add hooks or permissions.
        settingSources: [],
        systemPrompt: systemPrompt(agent, policy),
        includePartialMessages: true,
        maxTurns: agent.maxTurns ?? 20,
      },
    });

    let wroteText = false;
    try {
      for await (const message of session) {
        for (const event of this.toEvents(message, () => wroteText)) {
          if (event.type === 'text') wroteText = true;
          if (event.type === 'usage') {
            await this.claude.saveRateLimits(req.userId, event.rateLimits);
          }
          yield event;
        }
      }
    } catch (error) {
      if (req.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Agent ${agent.key} turn failed: ${message}`);
      yield { type: 'error', message };
    } finally {
      if (pluginDir) await rm(pluginDir, { recursive: true, force: true });
    }
  }

  /** Tools, MCP servers and skills the policy grants, and nothing else. */
  private capabilities(
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
  private confine(
    cwd: string,
    policy: AgentPolicy,
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
                const reason = await violation(
                  input.tool_name,
                  input.tool_input,
                );
                if (!reason) return {};
                this.logger.warn(`Denied ${input.tool_name}: ${reason}`);
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

  private *toEvents(
    message: SDKMessage,
    wroteText: () => boolean,
  ): Generator<ChatEvent> {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          yield {
            type: 'session',
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
            const target =
              input.file_path ?? input.pattern ?? input.path ?? null;
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
          rateLimits: toRateLimitSnapshot(message.rate_limit_info),
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
}
