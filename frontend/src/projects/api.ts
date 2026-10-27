import { api } from '../api/client'

export interface Project {
  id: number
  name: string
  path: string
  createdAt: string
  updatedAt: string
}

export interface ProjectInput {
  name: string
  path: string
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
}
