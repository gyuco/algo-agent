import { Injectable, NotFoundException } from '@nestjs/common';
import { CryptoService } from '../crypto/crypto.service.js';
import type { Secret } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Null: the user's own secrets, for all their projects. */
type Scope = number | null;

/** What leaves the backend: never the value. */
export interface SecretInfo {
  name: string;
  hint: string;
  updatedAt: Date;
}

/** Shows the end of long values only: of a short one it would give most away. */
const hint = (value: string) =>
  value.length >= 12 ? `…${value.slice(-4)}` : '…';

/**
 * Named secrets of a user or of one of their projects, that MCP servers refer
 * to as `${NAME}`. Values are write-only: they're decrypted only to start a run.
 */
@Injectable()
export class VaultService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** Binds a ciphertext to its row: moved to another user, project or name, it won't decrypt. */
  private context(userId: number, projectId: Scope, name: string) {
    return `secret:${userId}:${projectId ?? ''}:${name}`;
  }

  private info(row: Secret): SecretInfo {
    return { name: row.name, hint: row.hint, updatedAt: row.updatedAt };
  }

  async list(userId: number, projectId: Scope): Promise<SecretInfo[]> {
    const rows = await this.prisma.secret.findMany({
      where: { userId, projectId },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => this.info(r));
  }

  /** Creates or replaces a secret. */
  async set(userId: number, projectId: Scope, name: string, value: string) {
    const data = {
      valueEncrypted: this.crypto.encrypt(
        value,
        this.context(userId, projectId, name),
      ),
      hint: hint(value),
    };
    // No upsert: the unique key has a nullable column.
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.secret.findFirst({
        where: { userId, projectId, name },
        select: { id: true },
      });
      await (current
        ? tx.secret.update({ where: { id: current.id }, data })
        : tx.secret.create({ data: { userId, projectId, name, ...data } }));
    });
  }

  async remove(userId: number, projectId: Scope, name: string) {
    const { count } = await this.prisma.secret.deleteMany({
      where: { userId, projectId, name },
    });
    if (!count) throw new NotFoundException('Segreto non trovato');
  }

  /** The values a run in the project sees: the user's secrets, overridden by the project's. */
  async variables(
    userId: number,
    projectId: number | null,
  ): Promise<Record<string, string>> {
    const rows = await this.prisma.secret.findMany({
      where: {
        userId,
        OR: [
          { projectId: null },
          ...(projectId === null ? [] : [{ projectId }]),
        ],
      },
    });
    // The user's first, so the project's of the same name win.
    rows.sort(
      (a, b) => Number(a.projectId !== null) - Number(b.projectId !== null),
    );
    return Object.fromEntries(
      rows.map((r) => [
        r.name,
        this.crypto.decrypt(
          r.valueEncrypted,
          this.context(r.userId, r.projectId, r.name),
        ),
      ]),
    );
  }
}
