import { api } from '../api/client'
import type { ConnectionStatus } from '../connections/api'

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

/** The `details` of the Claude connection. */
export interface ClaudeDetails {
  /** Estimated from the connection date; null for API keys, which don't expire. */
  tokenExpiresAt: string | null
  /** Last plan usage reported by Claude Code; null until a prompt has run. */
  rateLimits: RateLimitSnapshot | null
}

export interface SetupTokenStart {
  sessionId: string
  authorizeUrl: string
}

const put = (path: string, body: unknown) =>
  api<ConnectionStatus>(path, { method: 'PUT', body: JSON.stringify(body) })

export const claudeApi = {
  connectApiKey: (apiKey: string) => put('/connections/claude/api-key', { apiKey }),
  connectOAuthToken: (token: string) => put('/connections/claude/oauth-token', { token }),
  startSetupToken: () =>
    api<SetupTokenStart>('/connections/claude/setup-token', { method: 'POST' }),
  completeSetupToken: (sessionId: string, code: string) =>
    api<ConnectionStatus>('/connections/claude/setup-token/complete', {
      method: 'POST',
      body: JSON.stringify({ sessionId, code }),
    }),
  refreshUsage: () =>
    api<ConnectionStatus>('/connections/claude/usage/refresh', { method: 'POST' }),
}
