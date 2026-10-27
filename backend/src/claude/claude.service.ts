import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
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
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CryptoService } from '../crypto/crypto.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type RateLimitSnapshot, toRateLimitSnapshot } from './rate-limit.js';
import { SetupTokenSession } from './setup-token.session.js';

const RUNTIME_CHECK_TIMEOUT_MS = 20_000;
const SETUP_URL_TIMEOUT_MS = 30_000;
const SETUP_CODE_TIMEOUT_MS = 60_000;
const SETUP_SESSION_TTL_MS = 10 * 60_000;
const TOKEN_VALIDATION_TIMEOUT_MS = 60_000;
// `claude setup-token` issues tokens valid for one year.
const OAUTH_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60_000;

export type ClaudeMethod = 'api_key' | 'oauth_token';

const ENV_VAR: Record<ClaudeMethod, string> = {
  api_key: 'ANTHROPIC_API_KEY',
  oauth_token: 'CLAUDE_CODE_OAUTH_TOKEN',
};

export interface ClaudeStatus {
  connected: boolean;
  method: ClaudeMethod | null;
  secretHint: string | null;
  /** Subscription login is offered only in personal mode, to the app owner. */
  subscriptionAvailable: boolean;
  /** Whether the Claude Code runtime started and picked up the user's credential. */
  runtime: { ok: boolean; error?: string } | null;
  session: ClaudeSessionInfo | null;
  error?: string;
}

export interface ClaudeSessionInfo {
  claudeCodeVersion: string | null;
  models: { value: string; displayName: string }[];
  connectedAt: string;
  /** Estimated from the connection date; null for API keys, which don't expire. */
  tokenExpiresAt: string | null;
  /** Last plan usage reported by Claude Code; null until a prompt has run. */
  rateLimits: RateLimitSnapshot | null;
}

interface RuntimeCheck {
  ok: boolean;
  error?: string;
  claudeCodeVersion?: string;
  models?: { value: string; displayName: string }[];
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

@Injectable()
export class ClaudeService implements OnModuleDestroy {
  private readonly logger = new Logger(ClaudeService.name);
  private readonly pendingSetups = new Map<string, PendingSetup>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  onModuleDestroy() {
    for (const id of this.pendingSetups.keys()) this.dropSetup(id);
  }

  async status(userId: number): Promise<ClaudeStatus> {
    const subscriptionAvailable = await this.isPersonalOwner(userId);
    const credential = await this.prisma.claudeCredential.findUnique({
      where: { userId },
    });
    if (!credential) {
      return {
        connected: false,
        method: null,
        secretHint: null,
        subscriptionAvailable,
        runtime: null,
        session: null,
      };
    }

    const method = credential.method as ClaudeMethod;
    const base = {
      method,
      secretHint: credential.secretHint,
      subscriptionAvailable,
      session: null,
    };
    if (method === 'oauth_token' && !subscriptionAvailable) {
      return {
        ...base,
        connected: false,
        runtime: null,
        error: 'Abbonamento disponibile solo in modalità personale',
      };
    }

    const secret = this.crypto.decrypt(credential.secretEncrypted);
    if (method === 'api_key') {
      const keyError = await this.validateApiKey(secret);
      if (keyError) {
        return { ...base, connected: false, runtime: null, error: keyError };
      }
    }
    const { claudeCodeVersion, models, ...runtime } = await this.checkRuntime(
      userId,
      method,
      secret,
    );
    if (!runtime.ok) return { ...base, connected: false, runtime };

    return {
      ...base,
      connected: true,
      runtime,
      session: {
        claudeCodeVersion: claudeCodeVersion ?? null,
        models: models ?? [],
        connectedAt: credential.createdAt.toISOString(),
        tokenExpiresAt:
          method === 'oauth_token'
            ? new Date(
                credential.createdAt.getTime() + OAUTH_TOKEN_LIFETIME_MS,
              ).toISOString()
            : null,
        rateLimits: credential.rateLimitJson
          ? (JSON.parse(credential.rateLimitJson) as RateLimitSnapshot)
          : null,
      },
    };
  }

  /**
   * Plan limits only reach the app inside prompt responses, so send a tiny
   * one. Uses a little of the subscription's quota.
   */
  async refreshUsage(userId: number): Promise<ClaudeStatus> {
    await this.assertSubscriptionAllowed(userId);
    const credential = await this.prisma.claudeCredential.findUnique({
      where: { userId },
    });
    if (credential?.method !== 'oauth_token') {
      throw new BadRequestException(
        'I limiti del piano esistono solo con un abbonamento collegato',
      );
    }
    const probe = await this.probeOAuthToken(
      userId,
      this.crypto.decrypt(credential.secretEncrypted),
    );
    if (probe.error) throw new BadRequestException(probe.error);
    await this.saveRateLimits(userId, probe.rateLimits);
    return this.status(userId);
  }

  async connectApiKey(userId: number, apiKey: string): Promise<ClaudeStatus> {
    const keyError = await this.validateApiKey(apiKey);
    if (keyError) throw new BadRequestException(keyError);
    await this.saveCredential(userId, 'api_key', apiKey);
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
  ): Promise<ClaudeStatus> {
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
  ): Promise<ClaudeStatus> {
    await this.assertSubscriptionAllowed(userId);
    const probe = await this.probeOAuthToken(userId, token);
    if (probe.error) throw new BadRequestException(probe.error);
    await this.saveCredential(userId, 'oauth_token', token);
    await this.saveRateLimits(userId, probe.rateLimits);
    return this.status(userId);
  }

  /** The user's stored credential, for running Agent SDK sessions on their behalf. */
  async credentialFor(
    userId: number,
  ): Promise<{ method: ClaudeMethod; secret: string }> {
    const credential = await this.prisma.claudeCredential.findUnique({
      where: { userId },
    });
    if (!credential) {
      throw new BadRequestException('Claude Code non è connesso');
    }
    const method = credential.method as ClaudeMethod;
    if (method === 'oauth_token') await this.assertSubscriptionAllowed(userId);
    return { method, secret: this.crypto.decrypt(credential.secretEncrypted) };
  }

  async disconnect(userId: number): Promise<void> {
    await this.prisma.claudeCredential.deleteMany({ where: { userId } });
  }

  /**
   * Environment for Agent SDK sessions run on behalf of a user. The config dir
   * is per user so the runtime never falls back to a Claude login present on
   * the host: the only credential it sees is the one passed here.
   */
  async agentEnv(
    userId: number,
    credential?: { method: ClaudeMethod; secret: string },
  ): Promise<Record<string, string>> {
    const configDir = join(process.cwd(), '.claude-runtime', String(userId));
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      CLAUDE_CONFIG_DIR: configDir,
      ...(credential && { [ENV_VAR[credential.method]]: credential.secret }),
    };
  }

  /** Personal mode and the app owner (first user): may use a subscription and run local MCP commands. */
  async isPersonalOwner(userId: number): Promise<boolean> {
    if (this.config.get('PERSONAL_MODE') !== 'true') return false;
    const owner = await this.prisma.user.findFirst({
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return owner?.id === userId;
  }

  private async assertSubscriptionAllowed(userId: number) {
    if (!(await this.isPersonalOwner(userId))) {
      throw new ForbiddenException(
        "Abbonamento disponibile solo in modalità personale, per il proprietario dell'app",
      );
    }
  }

  private async saveCredential(
    userId: number,
    method: ClaudeMethod,
    secret: string,
  ) {
    const data = {
      method,
      secretEncrypted: this.crypto.encrypt(secret),
      secretHint: `…${secret.slice(-4)}`,
      rateLimitJson: null,
      rateLimitAt: null,
    };
    await this.prisma.claudeCredential.upsert({
      where: { userId },
      // A new credential starts a new connection: reset its date too.
      update: { ...data, createdAt: new Date() },
      create: { userId, ...data },
    });
  }

  async saveRateLimits(userId: number, rateLimits: RateLimitSnapshot | null) {
    if (!rateLimits) return;
    await this.prisma.claudeCredential.update({
      where: { userId },
      data: {
        rateLimitJson: JSON.stringify(rateLimits),
        rateLimitAt: new Date(rateLimits.observedAt),
      },
    });
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
    method: ClaudeMethod,
    secret: string,
  ): Promise<RuntimeCheck> {
    // Never yields: keeps the session open for control requests without sending a prompt.
    const idle = async function* (): AsyncGenerator<never> {
      await new Promise<never>(() => {});
      yield* [];
    };
    const session = query({
      prompt: idle(),
      options: {
        env: await this.agentEnv(userId, { method, secret }),
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
        method === 'api_key' ? account.apiKeySource : account.tokenSource;
      if (source !== ENV_VAR[method]) {
        return {
          ok: false,
          error: 'Claude Code non usa la credenziale fornita',
        };
      }
      return {
        ok: true,
        claudeCodeVersion: init.claude_code_version,
        models: init.models.map(({ value, displayName }) => ({
          value,
          displayName,
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
