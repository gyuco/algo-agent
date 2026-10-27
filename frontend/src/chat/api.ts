import { api, apiStream } from '../api/client'
import type { Attachment } from './attachments'

export interface Workspace {
  path: string
  name: string
  entries: { name: string; dir: boolean }[]
}

export type ChatEvent =
  /** `sessionId` is opaque: send it back to continue the conversation. */
  | { type: 'session'; provider: string; sessionId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; target: string | null }
  /** New provider-specific connection details, e.g. Claude's plan usage. */
  | { type: 'usage'; provider: string; details: Record<string, unknown> }
  | { type: 'done'; isError: boolean; costUsd: number; durationMs: number; turns: number }
  | { type: 'error'; message: string }

export interface SendMessage {
  projectId: number
  /** Catalog agent that answers; the server's default assistant when omitted. */
  agent?: string
  message: string
  attachments?: Attachment[]
  sessionId?: string
  model?: string
}

export const chatApi = {
  workspace: (path: string) =>
    api<Workspace>('/chat/workspace', { method: 'POST', body: JSON.stringify({ path }) }),
  send: (body: SendMessage, signal: AbortSignal) =>
    apiStream<ChatEvent>('/chat/messages', body, signal),
}
