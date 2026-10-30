import { api } from '../api/client'

export interface Project {
  id: number
  name: string
  path: string
  /** Icon colour when there is no logo. */
  color: string | null
  /** Logo as a data URL or an http(s) URL. */
  logo: string | null
  createdAt: string
  updatedAt: string
}

export interface ProjectInput {
  name: string
  path: string
  color?: string | null
  logo?: string | null
}

export interface FolderListing {
  path: string
  root: string
  parent: string | null
  folders: string[]
}

export const projectsApi = {
  list: () => api<Project[]>('/projects'),
  get: (id: number) => api<Project>(`/projects/${id}`),
  create: (body: ProjectInput) =>
    api<Project>('/projects', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: number, body: ProjectInput) =>
    api<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  remove: (id: number) => api<null>(`/projects/${id}`, { method: 'DELETE' }),
  browse: (path?: string) =>
    api<FolderListing>(`/projects/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  folderAvailable: (name: string) =>
    api<{ available: boolean; reason?: string }>(
      `/projects/folder-available?name=${encodeURIComponent(name)}`,
    ),
}
