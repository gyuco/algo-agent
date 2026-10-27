import { api } from '../api/client'

export interface ClaudeStatus {
  connected: boolean
  method: 'api_key' | 'oauth_token' | null
  secretHint: string | null
  subscriptionAvailable: boolean
  runtime: { ok: boolean; error?: string } | null
  session: ClaudeSessionInfo | null
  error?: string
}

export interface RateLimitWindow {
  /** Fraction of the window used, 0-1. */
  utilization: number | null
  resetsAt: string | null
  status: 'allowed' | 'allowed_warning' | 'rejected' | null
}

export interface RateLimitSnapshot {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  windows: Record<string, RateLimitWindow>
  overage: { status: string | null; disabledReason: string | null }
  observedAt: string
}

export interface ClaudeSessionInfo {
  claudeCodeVersion: string | null
  models: { value: string; displayName: string }[]
  connectedAt: string
  tokenExpiresAt: string | null
  rateLimits: RateLimitSnapshot | null
}

export interface SetupTokenStart {
  sessionId: string
  authorizeUrl: string
}

const put = (path: string, body: unknown) =>
  api<ClaudeStatus>(path, { method: 'PUT', body: JSON.stringify(body) })

export const claudeApi = {
  status: () => api<ClaudeStatus>('/claude/status'),
  connectApiKey: (apiKey: string) => put('/claude/api-key', { apiKey }),
  connectOAuthToken: (token: string) => put('/claude/oauth-token', { token }),
  startSetupToken: () =>
    api<SetupTokenStart>('/claude/setup-token', { method: 'POST' }),
  completeSetupToken: (sessionId: string, code: string) =>
    api<ClaudeStatus>('/claude/setup-token/complete', {
      method: 'POST',
      body: JSON.stringify({ sessionId, code }),
    }),
  refreshUsage: () =>
    api<ClaudeStatus>('/claude/usage/refresh', { method: 'POST' }),
  disconnect: () => api<null>('/claude/credential', { method: 'DELETE' }),
}
