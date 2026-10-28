import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../crypto/crypto.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface StoredConnection {
  provider: string;
  method: string;
  /** Decrypted; null for methods that use credentials already on the machine. */
  secret: string | null;
  secretHint: string | null;
  /** Provider-specific state, e.g. Claude's last rate-limit snapshot. */
  state: Record<string, unknown>;
  createdAt: Date;
}

/** Stores each user's provider connections, secrets encrypted. */
@Injectable()
export class ConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  async find(
    userId: number,
    provider: string,
  ): Promise<StoredConnection | null> {
    const row = await this.prisma.providerConnection.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!row) return null;
    return {
      provider: row.provider,
      method: row.method,
      secret: row.secretEncrypted
        ? this.crypto.decrypt(row.secretEncrypted)
        : null,
      secretHint: row.secretHint,
      state: row.stateJson
        ? (JSON.parse(row.stateJson) as Record<string, unknown>)
        : {},
      createdAt: row.createdAt,
    };
  }

  /** Providers the user has a stored connection for. */
  async connected(userId: number): Promise<string[]> {
    const rows = await this.prisma.providerConnection.findMany({
      where: { userId },
      select: { provider: true },
    });
    return rows.map((r) => r.provider);
  }

  /** Stores a new connection, replacing any previous one and its state. */
  async save(
    userId: number,
    provider: string,
    method: string,
    secret: string | null = null,
  ) {
    const data = {
      method,
      secretEncrypted: secret ? this.crypto.encrypt(secret) : null,
      secretHint: secret ? `…${secret.slice(-4)}` : null,
      stateJson: null,
    };
    await this.prisma.providerConnection.upsert({
      where: { userId_provider: { userId, provider } },
      // A new credential starts a new connection: reset its date too.
      update: { ...data, createdAt: new Date() },
      create: { userId, provider, ...data },
    });
  }

  /** Merges `patch` into the connection's state; does nothing without a connection. */
  async updateState(
    userId: number,
    provider: string,
    patch: Record<string, unknown>,
  ) {
    const current = await this.find(userId, provider);
    if (!current) return;
    await this.prisma.providerConnection.update({
      where: { userId_provider: { userId, provider } },
      data: { stateJson: JSON.stringify({ ...current.state, ...patch }) },
    });
  }

  /** Also cancels the user's queued runs on that provider: they could only fail. */
  async remove(userId: number, provider: string) {
    await this.prisma.providerConnection.deleteMany({
      where: { userId, provider },
    });
    await this.prisma.run.updateMany({
      where: { userId, provider, status: 'queued' },
      data: {
        status: 'aborted',
        error: 'Connessione al provider rimossa',
        finishedAt: new Date(),
      },
    });
  }

  /**
   * Personal mode and the app owner (first user): may use credentials of the
   * host (a Claude subscription, a local OpenCode) and run local MCP commands.
   */
  async isPersonalOwner(userId: number): Promise<boolean> {
    if (this.config.get('PERSONAL_MODE') !== 'true') return false;
    const owner = await this.prisma.user.findFirst({
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return owner?.id === userId;
  }
}
