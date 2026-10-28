import { api } from '../api/client'
import type { FileAccess, Permissions } from '../agents/api'

export type EditableKind = 'agent' | 'mcp' | 'skill' | 'workflow'

interface Base {
  description: string
  enabledByDefault: boolean
}

export interface AgentSpec extends Base {
  model?: string
  maxTurns?: number
  permissions: Permissions
  prompt: string
}

/** Secret values (env, headers) always come back blank; sending a blank keeps the stored value. */
export type McpSpec = Base &
  (
    | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
    | { type: 'http'; url: string; headers: Record<string, string> }
  )

export interface SkillSpec extends Base {
  content: string
}

export interface WorkflowStep {
  id?: string
  agent: string
  prompt: string
  needs?: string[]
  approval?: boolean
  verdict?: string[]
  /** Runs the step, then the check `with`, until the check says `until`, at most `max` times. */
  repeat?: { with: string; until: string; max: number; onMax?: 'fail' | 'continue' }
}

export interface WorkflowSpec extends Base {
  input: string
  /** Without `id` a step is `step-<n>`; without `needs` it follows the step before. */
  steps: WorkflowStep[]
}

export interface SpecByKind {
  agent: AgentSpec
  mcp: McpSpec
  skill: SkillSpec
  workflow: WorkflowSpec
}

type Keyed<T> = T & { key: string }

export interface Library {
  agents: Keyed<AgentSpec>[]
  tools: { key: string; description: string; enabledByDefault: boolean }[]
  mcp: Keyed<McpSpec>[]
  skills: Keyed<SkillSpec>[]
  workflows: Keyed<WorkflowSpec>[]
  /** In a project: its own resources, as `kind:key`; the rest is the library. */
  own: string[]
  /** Whether this user may define MCP servers that run commands on the server. */
  stdioAllowed: boolean
}

/** Outcome of connecting to an MCP server as a run would. */
export type McpTestResult = { ok: true; tools: string[] } | { ok: false; error: string }

export type { FileAccess }

/** The library (projectId null), or one project's own resources next to the library. */
export function libraryApiFor(projectId: number | null) {
  const base = projectId === null ? '/resources' : `/projects/${projectId}/library`
  const path = (kind: EditableKind, key: string) => `${base}/${kind}/${encodeURIComponent(key)}`
  return {
    get: () => api<Library>(base),
    create: <K extends EditableKind>(kind: K, key: string, spec: SpecByKind[K]) =>
      api<null>(path(kind, key), { method: 'POST', body: JSON.stringify(spec) }),
    update: <K extends EditableKind>(kind: K, key: string, spec: SpecByKind[K]) =>
      api<null>(path(kind, key), { method: 'PUT', body: JSON.stringify(spec) }),
    remove: (kind: EditableKind, key: string) => api<null>(path(kind, key), { method: 'DELETE' }),
    /** `key`: the saved server being edited, whose stored secrets fill blank values. */
    testMcp: (spec: McpSpec, key?: string) =>
      api<McpTestResult>(`${base}/mcp-test`, {
        method: 'POST',
        body: JSON.stringify({ key, spec }),
      }),
    importExamples: () =>
      api<{ imported: string[] }>('/resources/import-examples', { method: 'POST' }),
  }
}
