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
  /** Whether this user may define MCP servers that run commands on the server. */
  stdioAllowed: boolean
}

export type { FileAccess }

const path = (kind: EditableKind, key: string) =>
  `/resources/${kind}/${encodeURIComponent(key)}`

export const libraryApi = {
  get: () => api<Library>('/resources'),
  create: <K extends EditableKind>(kind: K, key: string, spec: SpecByKind[K]) =>
    api<null>(path(kind, key), { method: 'POST', body: JSON.stringify(spec) }),
  update: <K extends EditableKind>(kind: K, key: string, spec: SpecByKind[K]) =>
    api<null>(path(kind, key), { method: 'PUT', body: JSON.stringify(spec) }),
  remove: (kind: EditableKind, key: string) => api<null>(path(kind, key), { method: 'DELETE' }),
  importExamples: () =>
    api<{ imported: string[] }>('/resources/import-examples', { method: 'POST' }),
}
