import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import { ConnectionsService } from '../connections/connections.service.js';
import { CryptoService } from '../crypto/crypto.service.js';
import type { Resource } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  buildCatalog,
  CatalogError,
  readCatalogDir,
  type Catalog,
  type CatalogEntry,
  type EditableKind,
  type McpSpec,
} from './catalog.js';

type Secrets = Record<string, string>;

/** The MCP field that holds secrets: env for a command, headers for a URL. */
const secretField = (spec: { type?: unknown }) =>
  spec.type === 'stdio' ? 'env' : 'headers';

/**
 * Each user's library of resources, kept in the DB. Every write is validated
 * against the whole library, so an agent can't refer to a missing MCP server
 * and a resource still in use can't be deleted.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly connections: ConnectionsService,
  ) {}

  /** Example resources shipped with the app (backend/catalog). */
  private examplesDir() {
    return resolve(this.config.get<string>('CATALOG_DIR') || 'catalog');
  }

  private secrets(row: Resource): Secrets {
    return row.secretsEncrypted
      ? (JSON.parse(this.crypto.decrypt(row.secretsEncrypted)) as Secrets)
      : {};
  }

  /** A row as a catalog entry; secret values are blanked unless `withSecrets`. */
  private toEntry(row: Resource, withSecrets: boolean): CatalogEntry {
    const spec = JSON.parse(row.specJson) as Record<string, unknown>;
    if (row.kind === 'mcp') {
      const secrets = this.secrets(row);
      spec[secretField(spec)] = withSecrets
        ? secrets
        : Object.fromEntries(Object.keys(secrets).map((k) => [k, '']));
    }
    return { kind: row.kind as EditableKind, key: row.key, spec };
  }

  private rows(userId: number) {
    return this.prisma.resource.findMany({
      where: { userId },
      orderBy: { key: 'asc' },
    });
  }

  /** The user's catalog with secrets, for running agents. */
  async forUser(userId: number): Promise<Catalog> {
    const rows = await this.rows(userId);
    return buildCatalog(rows.map((r) => this.toEntry(r, true)));
  }

  /** The user's library for the editor: secret values are never sent back. */
  async library(userId: number) {
    const rows = await this.rows(userId);
    const catalog = buildCatalog(rows.map((r) => this.toEntry(r, false)));
    return {
      agents: [...catalog.agents.values()],
      tools: [...catalog.tools.values()].map(
        ({ key, description, enabledByDefault }) => ({
          key,
          description,
          enabledByDefault,
        }),
      ),
      mcp: [...catalog.mcp.values()],
      skills: [...catalog.skills.values()],
      workflows: [...catalog.workflows.values()],
      stdioAllowed: await this.connections.isPersonalOwner(userId),
    };
  }

  async create(userId: number, kind: EditableKind, key: string, spec: unknown) {
    const rows = await this.rows(userId);
    if (rows.some((r) => r.kind === kind && r.key === key)) {
      throw new ConflictException(`Esiste già: ${kind} ${key}`);
    }
    await this.save(userId, rows, { kind, key, spec }, null);
  }

  /** Replaces a resource. A blank MCP secret value keeps the stored one. */
  async update(userId: number, kind: EditableKind, key: string, spec: unknown) {
    const rows = await this.rows(userId);
    const current = rows.find((r) => r.kind === kind && r.key === key);
    if (!current) throw new NotFoundException('Risorsa non trovata');
    await this.save(userId, rows, { kind, key, spec }, current);
  }

  async remove(userId: number, kind: EditableKind, key: string) {
    const rows = await this.rows(userId);
    const current = rows.find((r) => r.kind === kind && r.key === key);
    if (!current) throw new NotFoundException('Risorsa non trovata');
    try {
      buildCatalog(
        rows.filter((r) => r !== current).map((r) => this.toEntry(r, true)),
      );
    } catch (error) {
      if (error instanceof CatalogError) {
        throw new ConflictException(`Ancora in uso: ${error.message}`);
      }
      throw error;
    }
    await this.prisma.$transaction([
      this.prisma.resource.delete({ where: { id: current.id } }),
      this.prisma.projectResource.deleteMany({
        where: { kind, key, project: { userId } },
      }),
    ]);
  }

  /** Adds the example resources the user doesn't have yet; returns their keys. */
  async importExamples(userId: number) {
    const rows = await this.rows(userId);
    const have = new Set(rows.map((r) => `${r.kind}:${r.key}`));
    const allowStdio = await this.connections.isPersonalOwner(userId);
    const added = (await readCatalogDir(this.examplesDir())).filter(
      (e) =>
        !have.has(`${e.kind}:${e.key}`) &&
        (allowStdio ||
          e.kind !== 'mcp' ||
          secretField(e.spec as object) !== 'env'),
    );
    const catalog = this.validate([
      ...rows.map((r) => this.toEntry(r, true)),
      ...added,
    ]);
    await this.prisma.$transaction(
      added.map((e) =>
        this.prisma.resource.create({
          data: {
            userId,
            kind: e.kind,
            key: e.key,
            ...this.stored(catalog, e),
          },
        }),
      ),
    );
    return { imported: added.map((e) => `${e.kind}:${e.key}`) };
  }

  private async save(
    userId: number,
    rows: Resource[],
    entry: CatalogEntry,
    current: Resource | null,
  ) {
    if (entry.kind === 'mcp' && current) {
      entry = { ...entry, spec: this.keepSecrets(entry.spec, current) };
    }
    const catalog = this.validate([
      ...rows.filter((r) => r !== current).map((r) => this.toEntry(r, true)),
      entry,
    ]);
    if (
      entry.kind === 'mcp' &&
      catalog.mcp.get(entry.key)?.type === 'stdio' &&
      !(await this.connections.isPersonalOwner(userId))
    ) {
      throw new ForbiddenException(
        "I server MCP stdio eseguono comandi su questa macchina: solo il proprietario dell'app in modalità personale può crearli",
      );
    }
    const data = this.stored(catalog, entry);
    await (current
      ? this.prisma.resource.update({ where: { id: current.id }, data })
      : this.prisma.resource.create({
          data: { userId, kind: entry.kind, key: entry.key, ...data },
        }));
  }

  /** Fills blank secret values of an update with the stored ones. */
  private keepSecrets(spec: unknown, current: Resource): unknown {
    if (!spec || typeof spec !== 'object') return spec;
    const next = spec as Record<string, unknown>;
    const field = secretField(next);
    const incoming = next[field];
    if (!incoming || typeof incoming !== 'object') return spec;
    const stored = this.secrets(current);
    return {
      ...next,
      [field]: Object.fromEntries(
        Object.entries(incoming as Record<string, unknown>).map(([k, v]) => [
          k,
          v === '' && k in stored ? stored[k] : v,
        ]),
      ),
    };
  }

  private validate(entries: CatalogEntry[]): Catalog {
    try {
      return buildCatalog(entries);
    } catch (error) {
      if (error instanceof CatalogError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /** The validated spec as stored: MCP secrets go to their encrypted column. */
  private stored(catalog: Catalog, entry: CatalogEntry) {
    const maps = {
      agent: catalog.agents,
      mcp: catalog.mcp,
      skill: catalog.skills,
      workflow: catalog.workflows,
    };
    const { key: _key, ...spec } = maps[entry.kind].get(entry.key)! as {
      key: string;
    } & Record<string, unknown>;
    if (entry.kind !== 'mcp') {
      return { specJson: JSON.stringify(spec), secretsEncrypted: null };
    }
    const field = secretField(spec as McpSpec);
    const { [field]: secrets, ...rest } = spec;
    return {
      specJson: JSON.stringify(rest),
      secretsEncrypted: this.crypto.encrypt(JSON.stringify(secrets ?? {})),
    };
  }
}
