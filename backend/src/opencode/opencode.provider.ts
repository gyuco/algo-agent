import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppMcpService, type AppMcpRun } from '../app-mcp/app-mcp.service.js';
import type { SkillSpec } from '../catalog/catalog.js';
import { skillFile } from '../catalog/runtime.js';
import { ConnectionsService } from '../connections/connections.service.js';
import type {
  AgentProvider,
  ChatEvent,
  ModelOption,
  ProviderStatus,
  RunContext,
} from '../providers/provider.js';
import { APP_SERVER } from '../agents/policy.js';
import {
  APP_AGENT,
  appToolsServer,
  localConfig,
  mcpServer,
  runConfig,
  type AgentConfig,
  type SubagentConfig,
} from './opencode-config.js';
import { TurnEvents } from './opencode-events.js';
import {
  SUBAGENT_ACTION,
  delegationViolation,
  mcpServerName,
  permissionRules,
  permissionViolation,
  subagentId,
  type PermissionRequest,
} from './opencode-policy.js';
import { OpencodeError, OpencodeServer } from './opencode-server.js';

/** Provider id of OpenCode. */
export const OPENCODE = 'opencode';

const MCP_START_TIMEOUT_MS = 30_000;
/** OpenCode registers a server's tools a moment after reporting it connected. */
const MCP_SETTLE_MS = 500;

type McpServers = Record<string, Record<string, unknown>>;

/** The project's agents are OpenCode subagents under prefixed ids (see subagentId). */
const DELEGATION_NOTE =
  'In the subagent tool, name an agent by the id its description lists (agent_<name>).';

/** What a run's config folder holds besides the user's providers. */
interface RunFiles {
  agent: AgentConfig;
  subagents: Record<string, SubagentConfig>;
  mcp: McpServers;
  skills: SkillSpec[];
}

interface McpStatus {
  name: string;
  status: { status: string; error?: string };
}

interface ModelInfo {
  id: string;
  providerID: string;
  name: string;
  enabled: boolean;
}

interface SessionInfo {
  id: string;
  agent?: string;
  model?: { id: string; providerID: string };
  location: { directory: string };
}

/** `<providerID>/<model id>`, the form OpenCode itself lists models in. */
function modelValue(model: { providerID: string; id: string }) {
  return `${model.providerID}/${model.id}`;
}

function modelRef(value: string) {
  const slash = value.indexOf('/');
  if (slash <= 0) {
    throw new BadRequestException(`Modello OpenCode non valido: ${value}`);
  }
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
}

/** The user's environment variables a run may see, besides the ones set for it. */
const PASSED_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'TMPDIR',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
];

/**
 * OpenCode run locally (personal mode), with the providers and credentials
 * already set up on the machine. Each run starts a private server whose
 * config holds only those providers, the app's agent and the MCP servers and
 * skills the agent may use; the app's own tools are served to it over MCP.
 */
@Injectable()
export class OpencodeProvider implements AgentProvider {
  readonly id = OPENCODE;
  readonly label = 'OpenCode';
  readonly supports = { tools: true, mcp: true, skills: true, agents: true };

  private readonly logger = new Logger(OpencodeProvider.name);

  constructor(
    private readonly connections: ConnectionsService,
    private readonly config: ConfigService,
    private readonly appMcp: AppMcpService,
  ) {}

  async status(userId: number): Promise<ProviderStatus> {
    const owner = await this.connections.isPersonalOwner(userId);
    const connection = await this.connections.find(userId, OPENCODE);
    const base = {
      methods: owner ? ['local'] : [],
      connected: false,
      method: connection?.method ?? null,
      secretHint: null,
      connectedAt: connection?.createdAt.toISOString() ?? null,
      version: null,
      models: [],
    };
    if (!connection) return base;
    if (!owner) {
      return {
        ...base,
        error: 'OpenCode locale disponibile solo in modalità personale',
      };
    }
    try {
      return { ...base, connected: true, ...(await this.probe(userId)) };
    } catch (error) {
      return { ...base, error: (error as Error).message };
    }
  }

  /** Connects the OpenCode installed on this machine, once it shows at least one model. */
  async connectLocal(userId: number): Promise<ProviderStatus> {
    await this.assertOwner(userId);
    let models: ModelOption[];
    try {
      ({ models } = await this.probe(userId));
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    if (!models.length) {
      throw new BadRequestException(
        'OpenCode non ha modelli disponibili: collega un provider con `opencode auth`',
      );
    }
    await this.connections.save(userId, OPENCODE, 'local');
    return this.status(userId);
  }

  async disconnect(userId: number): Promise<void> {
    await this.connections.remove(userId, OPENCODE);
  }

  async *run(ctx: RunContext): AsyncGenerator<ChatEvent> {
    await this.assertConnected(ctx.userId);
    let appTools: AppMcpRun | null = null;
    let runDir: string | null = null;
    let server: OpencodeServer | null = null;
    const stream = new AbortController();
    ctx.signal.addEventListener('abort', () => stream.abort(), { once: true });
    let session: SessionInfo | null = null;
    try {
      if (ctx.policy.tools.length) {
        appTools = this.appMcp.open(
          ctx.policy.tools.map((k) =>
            ctx.catalog.tools.get(k)!.create({ cwd: ctx.cwd }),
          ),
        );
      }
      const mcp = this.mcpServers(ctx, appTools);
      runDir = await this.runDir(ctx.userId, {
        agent: {
          system: ctx.subagents.length
            ? `${ctx.systemPrompt}\n${DELEGATION_NOTE}`
            : ctx.systemPrompt,
          steps: ctx.agent.maxTurns ?? 20,
          permissions: permissionRules(
            ctx.policy,
            ctx.subagents.map((s) => s.agent.key),
          ),
        },
        subagents: Object.fromEntries(
          ctx.subagents.map((s) => [
            subagentId(s.agent.key),
            {
              description: s.agent.description,
              system: s.systemPrompt,
              steps: s.agent.maxTurns ?? 20,
              permissions: permissionRules(s.policy),
              ...(s.model && { model: s.model }),
            },
          ]),
        ),
        mcp,
        skills: ctx.policy.skills.map((k) => ctx.catalog.skills.get(k)!),
      });
      server = await this.start(runDir);
      // Before the session: it keeps the tools that were ready when it started.
      await this.waitForMcp(server, ctx.cwd, Object.keys(mcp));
      session = await this.session(server, ctx);
      const turn = new TurnEvents(session.id);
      const events = await server.events(stream.signal);
      const model = ctx.model ?? (session.model && modelValue(session.model));
      yield {
        type: 'session',
        provider: OPENCODE,
        sessionId: session.id,
        model: model ?? '',
      };

      await server.request('POST', `/api/session/${session.id}/prompt`, {
        text: ctx.prompt.text,
        files: ctx.prompt.attachments.map((a) => ({
          uri: `data:${a.mediaType};base64,${a.data}`,
          name: a.name,
        })),
      });

      for await (const event of events) {
        if (!turn.concerns(event)) continue;
        if (event.type === 'permission.asked') {
          const request = event.data as PermissionRequest & {
            sessionID: string;
          };
          await this.answer(
            server,
            ctx,
            request,
            turn.agentOf(request.sessionID),
          );
          continue;
        }
        yield* turn.map(event);
        if (turn.finished) break;
      }
    } catch (error) {
      if (ctx.signal.aborted) return;
      if (error instanceof OpencodeError) {
        throw new BadRequestException(`OpenCode: ${error.message}`);
      }
      throw error;
    } finally {
      stream.abort();
      if (server && session && ctx.signal.aborted) {
        // Stop the model before the server goes, so the session isn't left running.
        await server
          .request('POST', `/api/session/${session.id}/interrupt`, {})
          .catch(() => {});
      }
      server?.close();
      appTools?.close();
      if (runDir) await rm(runDir, { recursive: true, force: true });
    }
  }

  /** The MCP servers the policy grants, the app's tools among them, by their name in OpenCode. */
  private mcpServers(ctx: RunContext, appTools: AppMcpRun | null): McpServers {
    const servers: McpServers = {};
    if (appTools) {
      servers[APP_SERVER] = appToolsServer(appTools.url, appTools.token);
    }
    for (const key of ctx.policy.mcp) {
      servers[mcpServerName(key)] = mcpServer(ctx.catalog.mcp.get(key)!);
    }
    return servers;
  }

  /**
   * OpenCode connects MCP servers in the background when a folder is first
   * used (asking for their status starts it), and a session started before
   * then goes without their tools: wait until each one has connected or failed.
   */
  private async waitForMcp(
    server: OpencodeServer,
    cwd: string,
    names: string[],
  ) {
    if (!names.length) return;
    const query = `location[directory]=${encodeURIComponent(cwd)}`;
    const deadline = Date.now() + MCP_START_TIMEOUT_MS;
    for (;;) {
      const { data } = await server.request<{ data: McpStatus[] }>(
        'GET',
        `/api/mcp?${query}`,
      );
      const pending = names.filter((name) => {
        const status = data.find((s) => s.name === name)?.status;
        return !status || status.status === 'pending';
      });
      if (!pending.length) {
        for (const s of data) {
          if (s.status.status !== 'connected') {
            this.logger.warn(
              `MCP ${s.name} ${s.status.status}: ${s.status.error ?? ''}`,
            );
          }
        }
        await new Promise((resolve) => setTimeout(resolve, MCP_SETTLE_MS));
        return;
      }
      if (Date.now() > deadline) {
        this.logger.warn(`MCP not ready in time: ${pending.join(', ')}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** A new session in the project folder, or the one to continue if it really is in that folder. */
  private async session(
    server: OpencodeServer,
    ctx: RunContext,
  ): Promise<SessionInfo> {
    const model = ctx.model ? modelRef(ctx.model) : undefined;
    if (!ctx.sessionId) {
      const created = await server.request<{ data: SessionInfo }>(
        'POST',
        '/api/session',
        { location: { directory: ctx.cwd }, agent: APP_AGENT, model },
      );
      return created.data;
    }

    const path = `/api/session/${encodeURIComponent(ctx.sessionId)}`;
    let session: SessionInfo;
    try {
      ({ data: session } = await server.request<{ data: SessionInfo }>(
        'GET',
        path,
      ));
    } catch (error) {
      if (error instanceof OpencodeError && error.status === 404) {
        throw new BadRequestException(
          'Conversazione non trovata: iniziane una nuova',
        );
      }
      throw error;
    }
    const directory = await realpath(session.location.directory).catch(
      () => session.location.directory,
    );
    if (directory !== ctx.cwd) {
      throw new BadRequestException(
        "La conversazione appartiene a un'altra cartella",
      );
    }
    if (session.agent !== APP_AGENT) {
      await server.request('POST', `${path}/agent`, { agent: APP_AGENT });
    }
    if (model) await server.request('POST', `${path}/model`, { model });
    return session;
  }

  /**
   * Lets a tool call through only if the app's own policy check passes: the
   * main agent's, or the subagent's own when the call comes from its session.
   */
  private async answer(
    server: OpencodeServer,
    ctx: RunContext,
    request: PermissionRequest & { sessionID: string },
    /** null for the main session; undefined for one the app didn't start. */
    agent: string | null | undefined,
  ) {
    const policy =
      agent === null
        ? ctx.policy
        : ctx.subagents.find((s) => s.agent.key === agent)?.policy;
    const reason = !policy
      ? 'Agente sconosciuto'
      : request.action === SUBAGENT_ACTION
        ? delegationViolation(
            ctx.subagents.map((s) => s.agent.key),
            agent !== null,
            request,
          )
        : await permissionViolation(ctx.cwd, policy, request);
    if (reason) {
      this.logger.warn(
        `Denied ${request.action} ${request.resources.join(', ')}: ${reason}`,
      );
    }
    await server.request(
      'POST',
      `/api/session/${request.sessionID}/permission/${encodeURIComponent(request.id)}/reply`,
      reason ? { decision: 'reject', message: reason } : { decision: 'once' },
    );
  }

  /** Version and models of the local OpenCode, from a short-lived server. */
  private async probe(
    userId: number,
  ): Promise<Pick<ProviderStatus, 'version' | 'models'>> {
    const runDir = await this.runDir(userId);
    const server = await this.start(runDir);
    try {
      const info = await server.request<{ version: string }>(
        'GET',
        '/api/info',
      );
      const models = await server.request<{ data: ModelInfo[] }>(
        'GET',
        '/api/model',
      );
      return {
        version: info.version,
        models: models.data
          .filter((m) => m.enabled)
          .map((m) => ({
            value: modelValue(m),
            displayName: `${m.name} · ${m.providerID}`,
          })),
      };
    } finally {
      server.close();
      await rm(runDir, { recursive: true, force: true });
    }
  }

  /** A fresh folder holding one run's config and skills, under a per-user root only the app reads. */
  private async runDir(userId: number, files?: RunFiles) {
    const root = join(process.cwd(), '.opencode-runtime', String(userId));
    await mkdir(root, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(root, 'run-'));
    const config = join(dir, 'opencode');
    await mkdir(config);
    await writeFile(
      join(config, 'opencode.json'),
      JSON.stringify(
        runConfig(
          await localConfig(),
          files?.agent,
          files?.mcp,
          files?.subagents,
        ),
      ),
      { mode: 0o600 },
    );
    for (const skill of files?.skills ?? []) {
      await mkdir(join(config, 'skills', skill.key), { recursive: true });
      await writeFile(
        join(config, 'skills', skill.key, 'SKILL.md'),
        skillFile(skill),
      );
    }
    return dir;
  }

  /**
   * Starts OpenCode with `runDir` as its config home, so it reads only the
   * config written there; the project's own OpenCode and Claude Code files
   * are ignored too, since they could change permissions.
   */
  private start(runDir: string) {
    const env: Record<string, string> = {};
    for (const key of PASSED_ENV) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return OpencodeServer.start(
      this.config.get<string>('OPENCODE_BIN') || 'opencode',
      runDir,
      {
        ...env,
        XDG_CONFIG_HOME: runDir,
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
    );
  }

  private async assertOwner(userId: number) {
    if (!(await this.connections.isPersonalOwner(userId))) {
      throw new ForbiddenException(
        "OpenCode locale disponibile solo in modalità personale, per il proprietario dell'app",
      );
    }
  }

  private async assertConnected(userId: number) {
    if (!(await this.connections.find(userId, OPENCODE))) {
      throw new BadRequestException('OpenCode non è connesso');
    }
    await this.assertOwner(userId);
  }
}
