import { api } from '../api/client'

export interface ModelOption {
  /** Opaque reference: send it back as the chat's model. */
  value: string
  displayName: string
  /** Effort levels the model accepts, lowest first; none when it has no such choice. */
  efforts: string[]
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

/** A model of a connected provider, with the switch that makes the chat offer it. */
export interface ManagedModel extends ModelOption {
  provider: string
  providerLabel: string
  enabled: boolean
}

/** The models of every connected provider; `restricted`: the chat offers only the enabled ones. */
export interface ManagedModels {
  models: ManagedModel[]
  restricted: boolean
}

export const connectionsApi = {
  list: () => api<ConnectionStatus[]>('/connections'),
  disconnect: (provider: string) =>
    api<null>(`/connections/${provider}`, { method: 'DELETE' }),
  /** Every model of the connected providers, with its switch. */
  models: () => api<ManagedModels>('/resources/models'),
  /** The model references switched on: the chat offers only these, unless none is on. */
  enabledModels: () =>
    api<{ values: string[]; restricted: boolean }>('/resources/models/enabled'),
  setModelEnabled: (value: string, enabled: boolean) =>
    api<null>('/resources/models', {
      method: 'PUT',
      body: JSON.stringify({ value, enabled }),
    }),
}
