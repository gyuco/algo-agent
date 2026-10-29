import type { AgentPolicy } from '../agents/policy.js';
import type { AppToolDefinition } from '../app-mcp/app-mcp.js';
import type { AttachmentType } from '../chat/dto/chat.dto.js';
import type { AgentSpec, Catalog } from '../catalog/catalog.js';
import type { ToolContext } from '../catalog/app-tools.js';

export type ChatEvent =
  /** `sessionId` is opaque to clients: send it back to continue the conversation. */
  | { type: 'session'; provider: string; sessionId: string; model: string }
  /** `delegation` is the id of the delegation that produced it; absent for the main thread. */
  | { type: 'text'; text: string; delegation?: string }
  | { type: 'tool'; name: string; target: string | null; delegation?: string }
  /** The main thread handed a task to one of the project's agents. */
  | {
      type: 'delegation';
      id: string;
      agent: string;
      description: string;
      prompt: string;
    }
  | { type: 'delegation_done'; id: string; isError: boolean }
  /** New provider-specific connection details (e.g. Claude's plan usage). */
  | { type: 'usage'; provider: string; details: Record<string, unknown> }
  | {
      type: 'done';
      isError: boolean;
      costUsd: number;
      durationMs: number;
      turns: number;
    }
  | { type: 'error'; message: string };

export interface UserAttachment {
  name: string;
  mediaType: AttachmentType;
  /** Base64. */
  data: string;
}

/** What the user sent in one turn, in no provider's format. */
export interface UserTurn {
  text: string;
  attachments: UserAttachment[];
}

/** An agent the main thread may delegate to, already authorized like the main one. */
export interface Subagent {
  agent: AgentSpec;
  policy: AgentPolicy;
  systemPrompt: string;
  /** Model id within the provider; the main thread's model when omitted. */
  model?: string;
}

/** One agent turn, already authorized: the provider only has to run it. */
export interface RunContext {
  userId: number;
  /** Project folder, resolved and inside the workspace root. */
  cwd: string;
  agent: AgentSpec;
  /** What the agent may use, narrowed to what the provider supports. */
  policy: AgentPolicy;
  catalog: Catalog;
  systemPrompt: string;
  prompt: UserTurn;
  /** Model id within the provider; the provider's default when omitted. */
  model?: string;
  /** One of the model's effort levels; the model's default when omitted. */
  effort?: string;
  /** The provider's own id of the session to continue. */
  sessionId?: string;
  /** Tools of this run that aren't catalog resources (the mission tools). */
  appTools?: AppToolDefinition[];
  /** What those tools know about the run. */
  toolContext?: ToolContext;
  /** True once a closing tool ran: every other tool of the turn is denied. */
  turnClosed?: () => boolean;
  /** Agents the main thread may delegate to; empty unless the provider supports it. */
  subagents: Subagent[];
  signal: AbortSignal;
}

/** A past conversation in a project folder. */
export interface SessionSummary {
  /** The provider's own id, as `RunContext.sessionId` takes it. */
  id: string;
  title: string;
  /** ISO date of the last message. */
  updatedAt: string;
}

export interface ToolCall {
  name: string;
  target: string | null;
}

/** A task the main thread delegated, as a past conversation records it. */
export interface HistoryDelegation {
  id: string;
  agent: string;
  description: string;
  prompt: string;
  text: string;
  tools: ToolCall[];
  isError: boolean;
}

/** One message of a past conversation, in no provider's format. */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Files the user attached; their content is left out. */
  attachments: { name: string; mediaType: string }[];
  tools: ToolCall[];
  delegations: HistoryDelegation[];
}

export interface ModelOption {
  value: string;
  displayName: string;
  /** Effort levels the model accepts, lowest first; none when it has no such choice. */
  efforts: string[];
}

/** A provider's view of one user's connection. */
export interface ProviderStatus {
  /** Ways this user may connect here; empty when the provider isn't available to them. */
  methods: string[];
  connected: boolean;
  method: string | null;
  secretHint: string | null;
  connectedAt: string | null;
  /** Version of the agent runtime (Claude Code, OpenCode). */
  version: string | null;
  models: ModelOption[];
  error?: string;
  /** Provider-specific details for its own UI. */
  details?: Record<string, unknown>;
}

/** What the API returns: model values are qualified so any of them can be sent back as is. */
export interface ConnectionStatus extends ProviderStatus {
  provider: string;
  label: string;
}

/**
 * An agent runtime the app can connect to and run agents with. Connecting is
 * provider-specific (each has its own routes); everything else goes through here.
 */
export interface AgentProvider {
  readonly id: string;
  readonly label: string;
  /** What the provider can grant besides file access; the rest of a policy is dropped. */
  readonly supports: {
    tools: boolean;
    mcp: boolean;
    skills: boolean;
    /** Whether the main thread can delegate to subagents. */
    agents: boolean;
  };
  status(userId: number): Promise<ProviderStatus>;
  disconnect(userId: number): Promise<void>;
  run(ctx: RunContext): AsyncGenerator<ChatEvent>;
  /** Conversations held in `cwd` (resolved project folder), newest first. */
  sessions(userId: number, cwd: string): Promise<SessionSummary[]>;
  /** A conversation's messages; null when it isn't one of `cwd`'s. */
  history(
    userId: number,
    cwd: string,
    sessionId: string,
  ): Promise<HistoryMessage[] | null>;
}
