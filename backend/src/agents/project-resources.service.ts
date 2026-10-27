import { Injectable, NotFoundException } from '@nestjs/common';
import type { AgentSpec, Catalog, ResourceKind } from '../catalog/catalog.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AgentPolicy } from './policy.js';

export type IsEnabled = (kind: ResourceKind, key: string) => boolean;

/** Which catalog resources each project has switched on. */
@Injectable()
export class ProjectResourcesService {
  constructor(private readonly prisma: PrismaService) {}

  private spec(c: Catalog, kind: ResourceKind, key: string) {
    const maps = {
      agent: c.agents,
      tool: c.tools,
      mcp: c.mcp,
      skill: c.skills,
      workflow: c.workflows,
    };
    return maps[kind].get(key);
  }

  /** A project's switches; a resource missing from the catalog is never enabled. */
  async isEnabled(projectId: number, catalog: Catalog): Promise<IsEnabled> {
    const rows = await this.prisma.projectResource.findMany({
      where: { projectId },
    });
    const overrides = new Map(
      rows.map((r) => [`${r.kind}:${r.key}`, r.enabled]),
    );
    return (kind, key) => {
      const spec = this.spec(catalog, kind, key);
      if (!spec) return false;
      return overrides.get(`${kind}:${key}`) ?? spec.enabledByDefault;
    };
  }

  /** The agent's permissions, narrowed to what the project has switched on. */
  policyFor(agent: AgentSpec, enabled: IsEnabled): AgentPolicy {
    const { files, tools, mcp, skills } = agent.permissions;
    return {
      files,
      tools: tools.filter((k) => enabled('tool', k)),
      mcp: mcp.filter((k) => enabled('mcp', k)),
      skills: skills.filter((k) => enabled('skill', k)),
    };
  }

  /** The whole catalog with the project's switches, for the settings page. */
  async list(projectId: number, c: Catalog) {
    const enabled = await this.isEnabled(projectId, c);
    return {
      agents: [...c.agents.values()].map((a) => ({
        key: a.key,
        description: a.description,
        model: a.model ?? null,
        enabled: enabled('agent', a.key),
        permissions: a.permissions,
        effective: this.policyFor(a, enabled),
      })),
      tools: [...c.tools.values()].map((t) => ({
        key: t.key,
        description: t.description,
        enabled: enabled('tool', t.key),
      })),
      mcp: [...c.mcp.values()].map((m) => ({
        key: m.key,
        description: m.description,
        type: m.type,
        enabled: enabled('mcp', m.key),
      })),
      skills: [...c.skills.values()].map((s) => ({
        key: s.key,
        description: s.description,
        enabled: enabled('skill', s.key),
      })),
      workflows: [...c.workflows.values()].map((w) => ({
        key: w.key,
        description: w.description,
        input: w.input,
        agents: w.steps.map((s) => s.agent),
        enabled: enabled('workflow', w.key),
      })),
    };
  }

  async set(
    projectId: number,
    catalog: Catalog,
    kind: ResourceKind,
    key: string,
    enabled: boolean,
  ) {
    if (!this.spec(catalog, kind, key)) {
      throw new NotFoundException('Risorsa non trovata nel catalogo');
    }
    await this.prisma.projectResource.upsert({
      where: { projectId_kind_key: { projectId, kind, key } },
      create: { projectId, kind, key, enabled },
      update: { enabled },
    });
  }
}
