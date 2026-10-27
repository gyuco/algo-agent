import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { homedir } from 'node:os';
import type { AgentSpec } from '../catalog/catalog.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { resolveWorkspace } from '../chat/workspace.js';
import { ConnectionsService } from '../connections/connections.service.js';
import { formatRef, parseRef } from '../providers/model-ref.js';
import type {
  AgentProvider,
  ChatEvent,
  UserTurn,
} from '../providers/provider.js';
import { ProvidersService } from '../providers/providers.service.js';
import type { AgentPolicy } from './policy.js';
import { ProjectResourcesService } from './project-resources.service.js';

export interface RunRequest {
  userId: number;
  project: { id: number; path: string };
  agent: string;
  prompt: UserTurn;
  /** Session to continue, as a `session` event returned it. */
  sessionId?: string;
  /** Overrides the agent's model: `<provider>:<model>`. */
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
    if (stdio.length && !(await this.connections.isPersonalOwner(userId))) {
      throw new BadRequestException(
        `I server MCP stdio (${stdio.join(', ')}) girano solo in modalità personale`,
      );
    }
    return { catalog, agent, policy };
  }

  /**
   * Which provider runs the turn, and with which model and session. A session
   * stays with its provider; otherwise the chosen model decides, then the
   * agent's, then the first provider connected.
   */
  private async target(req: RunRequest, agent: AgentSpec) {
    const ids = this.providers.ids();
    const session = req.sessionId ? parseRef(req.sessionId, ids) : null;
    const chosen = req.model ? parseRef(req.model, ids) : null;
    const own = agent.model ? parseRef(agent.model, ids) : null;
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

  /** Yields chat events as the provider streams them. */
  async *run(req: RunRequest): AsyncGenerator<ChatEvent> {
    const { catalog, agent, policy } = await this.agentFor(
      req.userId,
      req.project.id,
      req.agent,
    );
    const cwd = await resolveWorkspace(req.project.path, this.workspaceRoot());
    const { provider, model, sessionId } = await this.target(req, agent);
    const granted = narrow(policy, provider);

    let started = false;
    try {
      for await (const event of provider.run({
        userId: req.userId,
        cwd,
        agent,
        policy: granted,
        catalog,
        systemPrompt: systemPrompt(agent, granted),
        prompt: req.prompt,
        model,
        sessionId,
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
