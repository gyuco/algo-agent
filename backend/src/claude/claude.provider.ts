import {
  listSessions,
  query,
  type EffortLevel,
  type Options,
} from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ConnectionsService } from '../connections/connections.service.js';
import type {
  AgentProvider,
  ChatEvent,
  ModelOption,
  ProviderStatus,
  RunContext,
  SessionSummary,
} from '../providers/provider.js';
import { readHistory, TranscriptStore } from './claude-history.js';
import {
  CLAUDE,
  capabilities,
  confine,
  sdkPrompt,
  skillsPlugin,
  toEvents,
  turnState,
} from './claude-runtime.js';
import { type RateLimitSnapshot, toRateLimitSnapshot } from './rate-limit.js';
import { SetupTokenSession } from './setup-token.session.js';

const RUNTIME_CHECK_TIMEOUT_MS = 20_000;
const SETUP_URL_TIMEOUT_MS = 30_000;
const SETUP_CODE_TIMEOUT_MS = 60_000;
const SETUP_SESSION_TTL_MS = 10 * 60_000;
const TOKEN_VALIDATION_TIMEOUT_MS = 60_000;
// `claude setup-token` issues tokens valid for one year.
const OAUTH_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60_000;
/** Past conversations listed per project. */
const SESSIONS_LIMIT = 50;

export type ClaudeMethod = 'api_key' | 'oauth_token';

const ENV_VAR: Record<ClaudeMethod, string> = {
  api_key: 'ANTHROPIC_API_KEY',
  oauth_token: 'CLAUDE_CODE_OAUTH_TOKEN',
};

interface Credential {
  method: ClaudeMethod;
  secret: string;
}

interface RuntimeCheck {
  ok: boolean;
  error?: string;
  claudeCodeVersion?: string;
  models?: ModelOption[];
}

interface ProbeResult {
  error: string | null;
  rateLimits: RateLimitSnapshot | null;
}

interface PendingSetup {
  userId: number;
  session: SetupTokenSession;
  timer: NodeJS.Timeout;
}

/** Claude Code through the Agent SDK, with an API key or (personal mode) a Pro/Max subscription. */
@Injectable()
export class ClaudeProvider implements AgentProvider, OnModuleDestroy {
  readonly id = CLAUDE;
  readonly label = 'Claude Code';
  readonly supports = { tools: true, mcp: true, skills: true, agents: true };

  private readonly logger = new Logger(ClaudeProvider.name);
  private readonly pendingSetups = new Map<string, PendingSetup>();

  constructor(
    private readonly connections: ConnectionsService,
    private readonly config: ConfigService,
  ) {}

  onModuleDestroy() {
    for (const id of this.pendingSetups.keys()) this.dropSetup(id);
  }

  async status(userId: number): Promise<ProviderStatus> {
    const subscriptionAvailable =
      await this.connections.isPersonalOwner(userId);
    const methods: ClaudeMethod[] = subscriptionAvailable
      ? ['oauth_token', 'api_key']
      : ['api_key'];
    const connection = await this.connections.find(userId, CLAUDE);
    const base = {
      methods,
      connected: false,
      method: connection?.method ?? null,
      secretHint: connection?.secretHint ?? null,
      connectedAt: connection?.createdAt.toISOString() ?? null,
      version: null,
      models: [],
    };
    if (!connection?.secret) return base;

    const method = connection.method as ClaudeMethod;
    if (method === 'oauth_token' && !subscriptionAvailable) {
      return {
        ...base,
        error: 'Abbonamento disponibile solo in modalità personale',
      };
    }
    if (method === 'api_key') {
      const keyError = await this.validateApiKey(connection.secret);
      if (keyError) return { ...base, error: keyError };
    }
    const runtime = await this.checkRuntime(userId, {
      method,
      secret: connection.secret,
    });
    if (!runtime.ok) return { ...base, error: runtime.error };

    return {
      ...base,
      connected: true,
      version: runtime.claudeCodeVersion ?? null,
      // "default" stands for "no choice", which the chat already offers.
      models: (runtime.models ?? []).filter((m) => m.value !== 'default'),
      details: {
        tokenExpiresAt:
          method === 'oauth_token'
            ? new Date(
                connection.createdAt.getTime() + OAUTH_TOKEN_LIFETIME_MS,
              ).toISOString()
            : null,
        rateLimits: connection.state.rateLimits ?? null,
      },
    };
  }

  /**
   * Plan limits only reach the app inside prompt responses, so send a tiny
   * one. Uses a little of the subscription's quota.
   */
  async refreshUsage(userId: number): Promise<ProviderStatus> {
    await this.assertSubscriptionAllowed(userId);
    const connection = await this.connections.find(userId, CLAUDE);
    if (connection?.method !== 'oauth_token' || !connection.secret) {
      throw new BadRequestException(
        'I limiti del piano esistono solo con un abbonamento collegato',
      );
    }
    const probe = await this.probeOAuthToken(userId, connection.secret);
    if (probe.error) throw new BadRequestException(probe.error);
    await this.saveRateLimits(userId, probe.rateLimits);
    return this.status(userId);
  }

  async connectApiKey(userId: number, apiKey: string): Promise<ProviderStatus> {
    const keyError = await this.validateApiKey(apiKey);
    if (keyError) throw new BadRequestException(keyError);
    await this.connections.save(userId, CLAUDE, 'api_key', apiKey);
    return this.status(userId);
  }

  /** Starts `claude setup-token` and returns the URL where the user authorizes it. */
  async startSetupToken(userId: number) {
    await this.assertSubscriptionAllowed(userId);
    for (const [id, pending] of this.pendingSetups) {
      if (pending.userId === userId) this.dropSetup(id);
    }

    const env = await this.agentEnv(userId);
    const session = new SetupTokenSession(
      this.config.get<string>('CLAUDE_BIN') ?? 'claude',
      // The frontend opens the URL itself, so don't also open a browser on the server.
      { ...env, BROWSER: 'true' },
    );
    let authorizeUrl: string;
    try {
      authorizeUrl = await session.authorizeUrl(SETUP_URL_TIMEOUT_MS);
    } catch (error) {
      session.close();
      throw new BadRequestException((error as Error).message);
    }

    const sessionId = randomUUID();
    const timer = setTimeout(
      () => this.dropSetup(sessionId),
      SETUP_SESSION_TTL_MS,
    );
    this.pendingSetups.set(sessionId, { userId, session, timer });
    return { sessionId, authorizeUrl };
  }

  /** Passes the authorization code to `claude setup-token` and stores the resulting token. */
  async completeSetupToken(
    userId: number,
    sessionId: string,
    code: string,
  ): Promise<ProviderStatus> {
    const pending = this.pendingSetups.get(sessionId);
    if (!pending || pending.userId !== userId) {
      throw new NotFoundException('Sessione scaduta: riavvia il collegamento');
    }
    let token: string;
    try {
      token = await pending.session.submitCode(code, SETUP_CODE_TIMEOUT_MS);
    } catch (error) {
      const message = (error as Error).message;
      await this.logSetupOutput(pending.session, message);
      this.dropSetup(sessionId);
      throw new BadRequestException(message);
    }
    // The CLI has printed the token; its session is no longer needed.
    this.dropSetup(sessionId);
    return this.connectOAuthToken(userId, token);
  }

  /** Stores a token the user generated by running `claude setup-token` themselves. */
  async connectOAuthToken(
    userId: number,
    token: string,
  ): Promise<ProviderStatus> {
    await this.assertSubscriptionAllowed(userId);
    const probe = await this.probeOAuthToken(userId, token);
    if (probe.error) throw new BadRequestException(probe.error);
    await this.connections.save(userId, CLAUDE, 'oauth_token', token);
    await this.saveRateLimits(userId, probe.rateLimits);
    return this.status(userId);
  }

  async disconnect(userId: number): Promise<void> {
    await this.connections.remove(userId, CLAUDE);
  }

  async sessions(userId: number, cwd: string): Promise<SessionSummary[]> {
    const sessions = await listSessions({
      dir: cwd,
      sessionStore: new TranscriptStore(this.configDir(userId)),
      limit: SESSIONS_LIMIT,
    });
    return sessions.map((s) => ({
      id: s.sessionId,
      title: s.summary,
      updatedAt: new Date(s.lastModified).toISOString(),
    }));
  }

  history(userId: number, cwd: string, sessionId: string) {
    return readHistory(
      new TranscriptStore(this.configDir(userId)),
      cwd,
      sessionId,
    );
  }

  /** Yields chat events as Claude Code streams them. */
  async *run(ctx: RunContext): AsyncGenerator<ChatEvent> {
    const credential = await this.credentialFor(ctx.userId);
    const env = await this.agentEnv(ctx.userId, credential);
    const pluginDir = ctx.policy.skills.length
      ? await skillsPlugin(
          join(env.CLAUDE_CONFIG_DIR, 'runs'),
          ctx.policy.skills.map((k) => ctx.catalog.skills.get(k)!),
        )
      : null;
    const abortController = new AbortController();
    ctx.signal.addEventListener('abort', () => abortController.abort(), {
      once: true,
    });

    const session = query({
      prompt: sdkPrompt(ctx.prompt),
      options: {
        abortController,
        cwd: ctx.cwd,
        env,
        model: ctx.model,
        effort: ctx.effort as EffortLevel | undefined,
        resume: ctx.sessionId,
        ...capabilities(
          ctx.catalog,
          ctx.policy,
          ctx.cwd,
          pluginDir,
          ctx.subagents,
        ),
        ...confine(ctx.cwd, ctx.policy, this.logger, ctx.subagents),
        permissionMode: 'default',
        // Don't load the workspace's own settings: they could add hooks or permissions.
        settingSources: [],
        systemPrompt: ctx.systemPrompt,
        includePartialMessages: true,
        // So a delegated agent's work can be followed in the chat.
        forwardSubagentText: ctx.subagents.length > 0,
        maxTurns: ctx.agent.maxTurns ?? 20,
      },
    });

    const state = turnState();
    try {
      for await (const message of session) {
        for (const event of toEvents(message, state)) {
          if (event.type === 'usage') {
            await this.connections.updateState(
              ctx.userId,
              CLAUDE,
              event.details,
            );
          }
          yield event;
        }
      }
    } finally {
      if (pluginDir) await rm(pluginDir, { recursive: true, force: true });
    }
  }

  /** The user's stored credential, for running Agent SDK sessions on their behalf. */
  private async credentialFor(userId: number): Promise<Credential> {
    const connection = await this.connections.find(userId, CLAUDE);
    if (!connection?.secret) {
      throw new BadRequestException('Claude Code non è connesso');
    }
    const method = connection.method as ClaudeMethod;
    if (method === 'oauth_token') await this.assertSubscriptionAllowed(userId);
    return { method, secret: connection.secret };
  }

  /**
   * Environment for Agent SDK sessions run on behalf of a user. The config dir
   * is per user so the runtime never falls back to a Claude login present on
   * the host: the only credential it sees is the one passed here.
   */
  /** Where Claude Code keeps a user's state, transcripts included. */
  private configDir(userId: number) {
    return join(process.cwd(), '.claude-runtime', String(userId));
  }

  private async agentEnv(
    userId: number,
    credential?: Credential,
  ): Promise<Record<string, string>> {
    const configDir = this.configDir(userId);
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      CLAUDE_CONFIG_DIR: configDir,
      // A turn ends with its stream: delegated agents must finish inside it.
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      ...(credential && { [ENV_VAR[credential.method]]: credential.secret }),
    };
  }

  private async assertSubscriptionAllowed(userId: number) {
    if (!(await this.connections.isPersonalOwner(userId))) {
      throw new ForbiddenException(
        "Abbonamento disponibile solo in modalità personale, per il proprietario dell'app",
      );
    }
  }

  private async saveRateLimits(
    userId: number,
    rateLimits: RateLimitSnapshot | null,
  ) {
    if (rateLimits) {
      await this.connections.updateState(userId, CLAUDE, { rateLimits });
    }
  }

  /** Keeps what the CLI printed (secrets redacted) so a failed sign-in can be diagnosed. */
  private async logSetupOutput(session: SetupTokenSession, reason: string) {
    const file = join(process.cwd(), '.claude-runtime', 'setup-token.log');
    const entry = `--- ${new Date().toISOString()} ${reason}\n${session.redactedOutput()}\n`;
    await appendFile(file, entry, { mode: 0o600 }).catch(() => {});
    this.logger.warn(
      `claude setup-token failed (${reason}); output in ${file}`,
    );
  }

  private dropSetup(sessionId: string) {
    const pending = this.pendingSetups.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.session.close();
    this.pendingSetups.delete(sessionId);
  }

  /** Lists models: free, and fails fast on a bad or revoked key. */
  private async validateApiKey(apiKey: string): Promise<string | null> {
    try {
      await new Anthropic({ apiKey, maxRetries: 1 }).models.list({ limit: 1 });
      return null;
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        return 'API key non valida o revocata';
      }
      if (error instanceof Anthropic.PermissionDeniedError) {
        return 'API key senza permessi sufficienti';
      }
      if (error instanceof Anthropic.APIError) {
        this.logger.warn(
          `Anthropic API error ${error.status}: ${error.message}`,
        );
        return `Errore Anthropic API (${error.status ?? 'rete'})`;
      }
      throw error;
    }
  }

  /**
   * Claude Code doesn't check an OAuth token until it is used, so send one
   * tiny prompt through it. Uses a little of the subscription's quota.
   */
  private async probeOAuthToken(
    userId: number,
    token: string,
  ): Promise<ProbeResult> {
    let rateLimits: RateLimitSnapshot | null = null;
    const fail = (error: string): ProbeResult => ({ error, rateLimits });
    const abortController = new AbortController();
    const timer = setTimeout(
      () => abortController.abort(),
      TOKEN_VALIDATION_TIMEOUT_MS,
    );
    const options: Options = {
      abortController,
      env: await this.agentEnv(userId, {
        method: 'oauth_token',
        secret: token,
      }),
      model: 'haiku',
      maxTurns: 1,
      tools: [],
      settingSources: [],
      persistSession: false,
    };
    try {
      for await (const message of query({
        prompt: 'Reply with: OK',
        options,
      })) {
        if (message.type === 'rate_limit_event') {
          rateLimits = toRateLimitSnapshot(message.rate_limit_info);
        }
        if (message.type === 'assistant' && message.error) {
          return fail(
            message.error === 'authentication_failed'
              ? 'Token non valido o revocato'
              : `Claude Code ha risposto con errore: ${message.error}`,
          );
        }
        if (message.type === 'result') {
          return message.is_error
            ? fail(`Verifica del token non riuscita (${message.subtype})`)
            : { error: null, rateLimits };
        }
      }
      return fail('Claude Code non ha restituito un risultato');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`OAuth token validation failed: ${message}`);
      return fail(
        abortController.signal.aborted
          ? 'Verifica del token scaduta: Claude Code non ha risposto'
          : `Verifica del token non riuscita: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Starts Claude Code without sending a prompt, so no tokens are used. */
  private async checkRuntime(
    userId: number,
    credential: Credential,
  ): Promise<RuntimeCheck> {
    // Never yields: keeps the session open for control requests without sending a prompt.
    const idle = async function* (): AsyncGenerator<never> {
      await new Promise<never>(() => {});
      yield* [];
    };
    const session = query({
      prompt: idle(),
      options: {
        env: await this.agentEnv(userId, credential),
        settingSources: [],
        persistSession: false,
      },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const init = await Promise.race([
        session.initializationResult(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Claude Code non risponde')),
            RUNTIME_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      const { account } = init;
      const source =
        credential.method === 'api_key'
          ? account.apiKeySource
          : account.tokenSource;
      if (source !== ENV_VAR[credential.method]) {
        return {
          ok: false,
          error: 'Claude Code non usa la credenziale fornita',
        };
      }
      return {
        ok: true,
        claudeCodeVersion: init.claude_code_version,
        models: init.models.map((m) => ({
          value: m.value,
          displayName: m.displayName,
          efforts: (m.supportsEffort && m.supportedEffortLevels) || [],
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Claude Code runtime check failed: ${message}`);
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer);
      session.close();
    }
  }
}
