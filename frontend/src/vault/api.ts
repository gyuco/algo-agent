import { api } from '../api/client'

/** A secret as the server shows it: never its value. */
export interface SecretInfo {
  name: string
  /** Last characters of a long value, else just "…". */
  hint: string
  updatedAt: string
}

/** The user's own secrets (projectId null), or one project's, which override them. */
export function vaultApiFor(projectId: number | null) {
  const base = projectId === null ? '/secrets' : `/projects/${projectId}/secrets`
  const path = (name: string) => `${base}/${encodeURIComponent(name)}`
  return {
    list: () => api<SecretInfo[]>(base),
    set: (name: string, value: string) =>
      api<null>(path(name), { method: 'PUT', body: JSON.stringify({ value }) }),
    remove: (name: string) => api<null>(path(name), { method: 'DELETE' }),
  }
}
