import { api } from '../api/client'

export interface ModelOption {
  /** Opaque reference: send it back as the chat's model. */
  value: string
  displayName: string
}

/** One provider's connection, as every provider reports it. */
export interface ConnectionStatus {
  provider: string
  label: string
  /** Ways this user may connect; empty when the provider isn't available to them. */
  methods: string[]
  connected: boolean
  method: string | null
  secretHint: string | null
  connectedAt: string | null
  version: string | null
  models: ModelOption[]
  error?: string
  /** Provider-specific details, read by that provider's own components. */
  details?: Record<string, unknown>
}

export const connectionsApi = {
  list: () => api<ConnectionStatus[]>('/connections'),
  disconnect: (provider: string) =>
    api<null>(`/connections/${provider}`, { method: 'DELETE' }),
}
