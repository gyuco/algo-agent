import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { homedir } from 'node:os';
import type { AppToolDefinition } from '../app-mcp/app-mcp.js';
import type { AgentSpec } from '../catalog/catalog.js';
import { CatalogService } from '../catalog/catalog.service.js';
import type { ToolContext } from '../catalog/app-tools.js';
import { resolveWorkspace } from '../chat/workspace.js';
import { ConnectionsService } from '../connections/connections.service.js';
import { formatRef, parseRef } from '../providers/model-ref.js';
import type {
  AgentProvider,
  ChatEvent,
  Subagent,
  UserTurn,
} from '../providers/provider.js';
import { ProvidersService } from '../providers/providers.service.js';
import { RunConfig } from '../runs/run-config.js';
import type { AgentPolicy } from './policy.js';
import { ProjectResourcesService } from './project-resources.service.js';
import { trustedWorktreeCwd } from './trusted-cwd.js';

export interface RunRequest {
  userId: number;
  project: { id: number; path: string };
  /** Catalog agent that answers; without one the user chats with the model directly. */
  agent?: string;
  /** An agent outside the catalog, e.g. the mission orchestrator. */
  agentSpec?: AgentSpec;
  prompt: UserTurn;
  /** Session to continue, as a `session` event returned it. */
  sessionId?: string;
  /** Overrides the agent's model: `<provider>:<model>`. */
  model?: string;
  /** One of the chosen model's effort levels. */
  effort?: string;
  /**
   * The working folder of a mission's agent: a worktree under
   * `DATA_DIR/worktrees/<projectId>`. Set by the backend only, never by input.
   */
  cwd?: string;
  /** Tools of this run that aren't catalog resources, e.g. the mission tools. */
  appTools?: AppToolDefinition[];
  /** What those tools know about the run. */
  toolContext?: ToolContext;
  /** True once a closing tool ran: every other tool of the turn is denied. */
  turnClosed?: () => boolean;
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

/** Key of the main thread when the user picks no agent; not a valid catalog key. */
export const DIRECT_CHAT = '_chat';

/** The main thread of a direct chat: everything the project has switched on, and the agents it may delegate to. */
function directAgent(policy: AgentPolicy, subagents: Subagent[]): AgentSpec {
  const delegation = subagents.length
    ? [
        '',
        'You can delegate a self-contained task to one of these agents with your tool for running subagents, naming the agent.',
        'Run it in the foreground and wait for its result; never in the background.',
        'Delegate when the task matches what an agent is for; otherwise do the work yourself.',
        'Each agent has its own permissions and sees only the prompt you give it, so make that prompt complete.',
        ...subagents.map((s) => `- ${s.agent.key}: ${s.agent.description}`),
      ]
    : [];
  return {
    key: DIRECT_CHAT,
    description: 'Chat diretta con il modello',
    enabledByDefault: true,
    maxTurns: 50,
    permissions: { ...policy },
    prompt: [
      "You are a general-purpose coding assistant, like Claude Code, working on the files of the user's project.",
      'Make focused changes: touch only what the request needs, and say which files you changed.',
      ...delegation,
    ].join('\n'),
  };
}

/** The policy without what the provider can't grant. */
function narrow(policy: AgentPolicy, provider: AgentProvider): AgentPolicy {
  const { supports } = provider;
  return {
    files: policy.files,
    tools: supports.tools ? policy.tools : [],
    mcp: supports.mcp ? policy.mcp : [],
    skills: supports.skills ? policy.skills : [],
  };
}

/** A subagent's model id: its own when it belongs to `provider`; otherwise it runs on the main model. */
function subagentModel(agent: AgentSpec, provider: string, ids: string[]) {
  const own = agent.model ? parseRef(agent.model, ids) : null;
  return own?.provider === provider ? own.id : undefined;
}

/** Runs one agent turn in a project, with the provider the model belongs to and exactly the permissions its policy grants. */
@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly catalogService: CatalogService,
    private readonly resources: ProjectResourcesService,
    private readonly providers: ProvidersService,
    private readonly connections: ConnectionsService,
    private readonly runConfig: RunConfig,
  ) {}

  private workspaceRoot() {
    return this.config.get<string>('WORKSPACE_ROOT') || homedir();
  }

  /** The agent, if it exists and is switched on in the project, with what it may use. */
  async agentFor(userId: number, projectId: number, key: string) {
    const catalog = await this.catalogService.forProject(userId, projectId);
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
    if (stdio.length && !(await this.connections.isPersonalOwner(userId))) {
      throw new BadRequestException(
        `I server MCP stdio (${stdio.join(', ')}) girano solo in modalità personale`,
      );
    }
    return { catalog, agent, policy };
  }

  /** An agent that isn't in the catalog, with its own policy narrowed to the project's switches. */
  private async syntheticAgent(
    userId: number,
    projectId: number,
    agent: AgentSpec,
  ) {
    const catalog = await this.catalogService.forProject(userId, projectId);
    const enabled = await this.resources.isEnabled(projectId, catalog);
    return { catalog, agent, policy: this.resources.policyFor(agent, enabled) };
  }

  /**
   * A direct chat: the main thread may use everything the project has switched
   * on, and delegate to its agents, each with its own policy. Stdio MCP servers
   * are left out outside personal mode instead of refusing the turn, since the
   * user didn't ask for them.
   */
  private async directChat(
    userId: number,
    projectId: number,
    provider: AgentProvider,
  ) {
    const catalog = await this.catalogService.forProject(userId, projectId);
    const enabled = await this.resources.isEnabled(projectId, catalog);
    const stdioAllowed = await this.connections.isPersonalOwner(userId);
    const usable = (k: string) =>
      stdioAllowed || catalog.mcp.get(k)?.type !== 'stdio';
    const grant = (policy: AgentPolicy) =>
      narrow({ ...policy, mcp: policy.mcp.filter(usable) }, provider);

    const subagents: Subagent[] = provider.supports.agents
      ? [...catalog.agents.values()]
          .filter((a) => enabled('agent', a.key))
          .map((agent) => {
            const policy = grant(this.resources.policyFor(agent, enabled));
            return { agent, policy, systemPrompt: systemPrompt(agent, policy) };
          })
      : [];
    const policy = grant({
      files: 'write',
      tools: [...catalog.tools.keys()].filter((k) => enabled('tool', k)),
      mcp: [...catalog.mcp.keys()].filter((k) => enabled('mcp', k)),
      skills: [...catalog.skills.keys()].filter((k) => enabled('skill', k)),
    });
    return {
      catalog,
      agent: directAgent(policy, subagents),
      policy,
      subagents,
    };
  }

  /**
   * Which provider runs the turn, and with which model and session. A session
   * stays with its provider; otherwise the chosen model decides, then the
   * agent's, then the first provider connected.
   */
  private async target(
    req: Pick<RunRequest, 'userId' | 'sessionId' | 'model'>,
    agent?: AgentSpec,
  ) {
    const ids = this.providers.ids();
    const session = req.sessionId ? parseRef(req.sessionId, ids) : null;
    const chosen = req.model ? parseRef(req.model, ids) : null;
    const own = agent?.model ? parseRef(agent.model, ids) : null;
    if (session && chosen && chosen.provider !== session.provider) {
      throw new BadRequestException(
        'Il modello scelto è di un altro provider: inizia una nuova conversazione',
      );
    }
    const provider = session
      ? this.providers.get(session.provider)
      : chosen || own
        ? this.providers.get((chosen ?? own)!.provider)
        : await this.providers.defaultFor(req.userId);
    const model =
      chosen?.id ?? (own?.provider === provider.id ? own.id : undefined);
    return { provider, model, sessionId: session?.id };
  }

  /**
   * What `run` would refuse, checked without running: the agent, the provider
   * and the model. Returns the provider and whether the turn may write files.
   */
  async check(req: Omit<RunRequest, 'prompt' | 'signal'>) {
    const chosen = req.agentSpec
      ? await this.syntheticAgent(req.userId, req.project.id, req.agentSpec)
      : req.agent
        ? await this.agentFor(req.userId, req.project.id, req.agent)
        : null;
    const { provider } = await this.target(req, chosen?.agent);
    // A direct chat may write: it gets everything the project has on.
    return {
      provider: provider.id,
      writes: chosen ? chosen.policy.files === 'write' : true,
    };
  }

  /** Yields chat events as the provider streams them. */
  async *run(req: RunRequest): AsyncGenerator<ChatEvent> {
    const chosen = req.agentSpec
      ? await this.syntheticAgent(req.userId, req.project.id, req.agentSpec)
      : req.agent
        ? await this.agentFor(req.userId, req.project.id, req.agent)
        : null;
    const cwd = req.cwd
      ? await trustedWorktreeCwd(
          await this.runConfig.resolvedDataDir(),
          req.project.id,
          req.cwd,
        )
      : await resolveWorkspace(req.project.path, this.workspaceRoot());
    const { provider, model, sessionId } = await this.target(
      req,
      chosen?.agent,
    );
    const base = chosen
      ? { ...chosen, policy: narrow(chosen.policy, provider), subagents: [] }
      : await this.directChat(req.userId, req.project.id, provider);
    const appTools = req.appTools ?? [];
    const policy: AgentPolicy = {
      ...base.policy,
      tools: [...base.policy.tools, ...appTools.map((t) => t.name)],
    };
    const { catalog, agent, subagents } = base;
    const ids = this.providers.ids();

    let started = false;
    try {
      for await (const event of provider.run({
        userId: req.userId,
        cwd,
        agent,
        policy,
        catalog,
        systemPrompt: systemPrompt(agent, policy),
        prompt: req.prompt,
        model,
        effort: req.effort,
        sessionId,
        appTools,
        toolContext: req.toolContext,
        turnClosed: req.turnClosed,
        subagents: subagents.map((s) => ({
          ...s,
          model: subagentModel(s.agent, provider.id, ids),
        })),
        signal: req.signal,
      })) {
        started = true;
        yield event.type === 'session'
          ? { ...event, sessionId: formatRef(provider.id, event.sessionId) }
          : event;
      }
    } catch (error) {
      if (req.signal.aborted) return;
      // Refused before anything streamed (e.g. not connected): a plain HTTP error.
      if (!started && error instanceof HttpException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Agent ${agent.key} turn failed: ${message}`);
      yield { type: 'error', message };
    }
  }
}
