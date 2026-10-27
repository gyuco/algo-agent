import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { APP_SERVER, FILE_ACCESS } from '../agents/policy.js';
import { APP_TOOLS, type AppTool } from './app-tools.js';

export const RESOURCE_KINDS = [
  'agent',
  'tool',
  'mcp',
  'skill',
  'workflow',
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** Kinds a user defines; app tools are written in code. */
export const EDITABLE_KINDS = ['agent', 'mcp', 'skill', 'workflow'] as const;
export type EditableKind = (typeof EDITABLE_KINDS)[number];

export const keySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'minuscole, cifre e trattini');
const keys = z.array(z.string()).default([]);

const base = {
  description: z.string().trim().min(1).max(500),
  /** Switched on in a project until the project turns it off. */
  enabledByDefault: z.boolean().default(false),
};

const agentSchema = z
  .object({
    ...base,
    model: z.string().max(64).optional(),
    maxTurns: z.number().int().min(1).max(100).optional(),
    permissions: z
      .object({
        files: z.enum(FILE_ACCESS).default('none'),
        tools: keys,
        mcp: keys,
        skills: keys,
      })
      .strict()
      .prefault({}),
    /** System prompt. */
    prompt: z.string().trim().min(1).max(50_000),
  })
  .strict();

const stringMap = z.record(z.string(), z.string()).default({});
const mcpSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      env: stringMap,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('http'),
      url: z.url({ protocol: /^https?$/ }),
      headers: stringMap,
    })
    .strict(),
]);

const skillSchema = z
  .object({
    ...base,
    // A skill is only instructions: on unless a project turns it off.
    enabledByDefault: z.boolean().default(true),
    /** SKILL.md body, without frontmatter. */
    content: z.string().trim().min(1).max(100_000),
  })
  .strict();

const workflowSchema = z
  .object({
    ...base,
    /** Label of the text the user types to start a run. */
    input: z.string().default('Input'),
    steps: z
      .array(z.object({ agent: keySchema, prompt: z.string().min(1) }).strict())
      .min(1)
      .max(10),
  })
  .strict();

export const SCHEMAS = {
  agent: agentSchema,
  mcp: mcpSchema,
  skill: skillSchema,
  workflow: workflowSchema,
} as const;

export type AgentSpec = z.infer<typeof agentSchema> & { key: string };
export type McpSpec = z.infer<typeof mcpSchema> & { key: string };
export type SkillSpec = z.infer<typeof skillSchema> & { key: string };
export type WorkflowSpec = z.infer<typeof workflowSchema> & { key: string };
export type ToolSpec = AppTool & { key: string };

/** One user-defined resource before validation, from the DB or a catalog file. */
export interface CatalogEntry {
  kind: EditableKind;
  key: string;
  spec: unknown;
}

/** Everything agents can be given: the user's resources plus the app tools. */
export interface Catalog {
  agents: Map<string, AgentSpec>;
  tools: Map<string, ToolSpec>;
  mcp: Map<string, McpSpec>;
  skills: Map<string, SkillSpec>;
  workflows: Map<string, WorkflowSpec>;
}

/** An invalid resource, or one that refers to a resource that doesn't exist. */
export class CatalogError extends Error {}

function validate<T>(schema: z.ZodType<T>, data: unknown, where: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new CatalogError(`${where}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Validates the entries and every reference between them; throws CatalogError. */
export function buildCatalog(entries: CatalogEntry[]): Catalog {
  const catalog: Catalog = {
    agents: new Map(),
    tools: new Map(
      Object.entries(APP_TOOLS).map(([k, t]) => [k, { ...t, key: k }]),
    ),
    mcp: new Map(),
    skills: new Map(),
    workflows: new Map(),
  };
  const maps = {
    agent: catalog.agents,
    mcp: catalog.mcp,
    skill: catalog.skills,
    workflow: catalog.workflows,
  } as const;

  for (const { kind, key, spec } of entries) {
    const where = `${kind} ${key}`;
    if (!keySchema.safeParse(key).success) {
      throw new CatalogError(
        `${where}: nome non valido (minuscole, cifre e trattini)`,
      );
    }
    if (kind === 'mcp' && key === APP_SERVER) {
      throw new CatalogError(`${where}: "${APP_SERVER}" è riservato`);
    }
    const map = maps[kind] as Map<string, unknown>;
    if (map.has(key)) throw new CatalogError(`${where}: duplicato`);
    const schema: z.ZodType<object> = SCHEMAS[kind];
    map.set(key, { ...validate(schema, spec, where), key });
  }

  for (const agent of catalog.agents.values()) {
    const refs = [
      ['tools', catalog.tools],
      ['mcp', catalog.mcp],
      ['skills', catalog.skills],
    ] as const;
    for (const [field, known] of refs) {
      const missing = agent.permissions[field].filter((r) => !known.has(r));
      if (missing.length) {
        throw new CatalogError(
          `agent ${agent.key}: permissions.${field} sconosciuti: ${missing.join(', ')}`,
        );
      }
    }
  }
  for (const workflow of catalog.workflows.values()) {
    const missing = workflow.steps.filter((s) => !catalog.agents.has(s.agent));
    if (missing.length) {
      throw new CatalogError(
        `workflow ${workflow.key}: agenti sconosciuti: ${missing.map((s) => s.agent).join(', ')}`,
      );
    }
  }
  return catalog;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function frontmatter(source: string, file: string) {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new CatalogError(`${file}: manca il frontmatter YAML`);
  const data = (parse(match[1]) ?? {}) as Record<string, unknown>;
  return { data, body: match[2].trim() };
}

/** Files in `dir` with extension `ext`, as [key, path]; a missing folder is empty. */
async function files(dir: string, ext: string): Promise<[string, string][]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => extname(name) === ext)
    .sort()
    .map((name) => [basename(name, ext), join(dir, name)]);
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Reads a catalog folder (the examples shipped in backend/catalog):
 *
 *   agents/<key>.md          YAML frontmatter + system prompt
 *   mcp/<key>.yaml           MCP server (stdio or http)
 *   workflows/<key>.yaml     sequence of agent steps
 *   skills/<key>/SKILL.md
 */
export async function readCatalogDir(dir: string): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  for (const [key, file] of await files(join(dir, 'agents'), '.md')) {
    const { data, body } = frontmatter(await readFile(file, 'utf8'), file);
    entries.push({ kind: 'agent', key, spec: { ...data, prompt: body } });
  }
  for (const [key, file] of await files(join(dir, 'mcp'), '.yaml')) {
    entries.push({
      kind: 'mcp',
      key,
      spec: parse(await readFile(file, 'utf8')),
    });
  }
  for (const key of await subdirs(join(dir, 'skills'))) {
    const file = join(dir, 'skills', key, 'SKILL.md');
    const { data, body } = frontmatter(await readFile(file, 'utf8'), file);
    entries.push({
      kind: 'skill',
      key,
      spec: { description: data.description, content: body },
    });
  }
  for (const [key, file] of await files(join(dir, 'workflows'), '.yaml')) {
    entries.push({
      kind: 'workflow',
      key,
      spec: parse(await readFile(file, 'utf8')),
    });
  }
  return entries;
}
