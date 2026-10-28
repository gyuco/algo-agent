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
import { VaultService } from '../vault/vault.service.js';
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

/** Where a resource lives: null for the library, else the project it belongs to. */
export type Scope = number | null;

/** The MCP field that holds secrets: env for a command, headers for a URL. */
const secretField = (spec: { type?: unknown }) =>
  spec.type === 'stdio' ? 'env' : 'headers';

/**
 * Each user's resources, kept in the DB: their library, usable in all their
 * projects, and resources of one project only. A project sees both. Every
 * write is validated against what the scope sees, so an agent can't refer to
 * a missing MCP server and a resource still in use can't be deleted.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly connections: ConnectionsService,
    private readonly vault: VaultService,
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

  /** Every resource of the user, in the library and in all their projects. */
  private allRows(userId: number) {
    return this.prisma.resource.findMany({
      where: { userId },
      orderBy: { key: 'asc' },
    });
  }

  /** What a scope sees: the library, plus the project's own resources. */
  private visible(rows: Resource[], scope: Scope) {
    return rows.filter((r) => r.projectId === null || r.projectId === scope);
  }

  private catalogOf(rows: Resource[], scope: Scope, withSecrets: boolean) {
    const catalog = buildCatalog(
      this.visible(rows, scope).map((r) => this.toEntry(r, withSecrets)),
    );
    for (const r of rows) {
      if (scope !== null && r.projectId === scope) {
        catalog.own.add(`${r.kind}:${r.key}`);
      }
    }
    return catalog;
  }

  /** The catalog a scope sees, without the variables its MCP servers need to run. */
  async forUser(userId: number, scope: Scope = null): Promise<Catalog> {
    return this.catalogOf(await this.allRows(userId), scope, true);
  }

  /**
   * The catalog a run in the project uses: `${NAME}` in MCP servers resolve to
   * the project's secrets, then the user's. Only the app owner in personal mode
   * falls back to the backend's environment: it's their machine.
   */
  async forProject(userId: number, projectId: number): Promise<Catalog> {
    const [catalog, secrets, owner] = await Promise.all([
      this.forUser(userId, projectId),
      this.vault.variables(userId, projectId),
      this.connections.isPersonalOwner(userId),
    ]);
    const env = owner
      ? Object.fromEntries(
          Object.entries(process.env).filter(
            (e): e is [string, string] => e[1] !== undefined,
          ),
        )
      : {};
    return { ...catalog, variables: { ...env, ...secrets } };
  }

  /**
   * The resources a scope sees, for the editor: secret values are never sent
   * back. `own` lists the project's own ones as `kind:key`.
   */
  async library(userId: number, scope: Scope = null) {
    const catalog = this.catalogOf(await this.allRows(userId), scope, false);
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
      own: [...catalog.own],
      stdioAllowed: await this.connections.isPersonalOwner(userId),
    };
  }

  /** A project resource starts switched on in its project: it was made for it. */
  async create(
    userId: number,
    scope: Scope,
    kind: EditableKind,
    key: string,
    spec: unknown,
  ) {
    const rows = await this.allRows(userId);
    const taken = rows.find((r) => r.kind === kind && r.key === key);
    if (taken) {
      throw new ConflictException(
        taken.projectId === null
          ? `Esiste già nella libreria: ${kind} ${key}`
          : `Esiste già in un progetto: ${kind} ${key}`,
      );
    }
    await this.save(userId, scope, rows, { kind, key, spec }, null);
    if (scope !== null) {
      await this.prisma.projectResource.upsert({
        where: { projectId_kind_key: { projectId: scope, kind, key } },
        create: { projectId: scope, kind, key, enabled: true },
        update: { enabled: true },
      });
    }
  }

  /** Replaces a resource. A blank MCP secret value keeps the stored one. */
  async update(
    userId: number,
    scope: Scope,
    kind: EditableKind,
    key: string,
    spec: unknown,
  ) {
    const rows = await this.allRows(userId);
    const current = this.find(rows, scope, kind, key);
    await this.save(userId, scope, rows, { kind, key, spec }, current);
  }

  async remove(userId: number, scope: Scope, kind: EditableKind, key: string) {
    const rows = await this.allRows(userId);
    const current = this.find(rows, scope, kind, key);
    const rest = rows.filter((r) => r !== current);
    // A library resource may be in use in any project; a project's only there.
    const scopes =
      scope === null
        ? [null, ...new Set(rest.flatMap((r) => r.projectId ?? []))]
        : [scope];
    try {
      for (const s of scopes) this.catalogOf(rest, s, true);
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

  /** Adds to the library the examples whose key the user doesn't use yet; returns their keys. */
  async importExamples(userId: number) {
    const rows = await this.allRows(userId);
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
      ...this.visible(rows, null).map((r) => this.toEntry(r, true)),
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

  private find(
    rows: Resource[],
    scope: Scope,
    kind: EditableKind,
    key: string,
  ) {
    const row = rows.find(
      (r) => r.kind === kind && r.key === key && r.projectId === scope,
    );
    if (!row) throw new NotFoundException('Risorsa non trovata');
    return row;
  }

  private async save(
    userId: number,
    scope: Scope,
    rows: Resource[],
    entry: CatalogEntry,
    current: Resource | null,
  ) {
    if (entry.kind === 'mcp' && current) {
      entry = { ...entry, spec: this.keepSecrets(entry.spec, current) };
    }
    const catalog = this.validate([
      ...this.visible(rows, scope)
        .filter((r) => r !== current)
        .map((r) => this.toEntry(r, true)),
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
          data: {
            userId,
            projectId: scope,
            kind: entry.kind,
            key: entry.key,
            ...data,
          },
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
