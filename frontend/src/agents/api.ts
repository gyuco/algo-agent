import { api } from '../api/client'

export type FileAccess = 'none' | 'read' | 'write'
export type ResourceKind = 'agent' | 'tool' | 'mcp' | 'skill' | 'workflow'

export interface Permissions {
  files: FileAccess
  tools: string[]
  mcp: string[]
  skills: string[]
}

interface Resource {
  key: string
  description: string
  enabled: boolean
}

export interface AgentResource extends Resource {
  model: string | null
  /** What the agent asks for in the catalog. */
  permissions: Permissions
  /** What it gets in this project: its permissions narrowed to the resources switched on. */
  effective: Permissions
}

export interface WorkflowResource extends Resource {
  input: string
  agents: string[]
}

export interface ProjectResources {
  agents: AgentResource[]
  tools: Resource[]
  mcp: (Resource & { type: 'stdio' | 'http' })[]
  skills: Resource[]
  workflows: WorkflowResource[]
}

export const resourcesApi = {
  list: (projectId: number) => api<ProjectResources>(`/projects/${projectId}/resources`),
  set: (projectId: number, kind: ResourceKind, key: string, enabled: boolean) =>
    api<null>(`/projects/${projectId}/resources/${kind}/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
}
