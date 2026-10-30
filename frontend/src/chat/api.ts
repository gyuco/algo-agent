import { api } from "../api/client";
import type { RunStatus, WaitReason } from "../runs/api";
import type { Attachment } from "./attachments";

export interface Workspace {
  path: string;
  name: string;
  entries: { name: string; dir: boolean }[];
}

export type ChatEvent =
  /** `sessionId` is opaque: send it back to continue the conversation. */
  | { type: "session"; provider: string; sessionId: string; model: string }
  /** `delegation` is the delegation that produced it; absent for the main thread. */
  | { type: "text"; text: string; delegation?: string }
  | { type: "tool"; name: string; target: string | null; delegation?: string }
  /** The main thread handed a task to one of the project's agents. */
  | {
      type: "delegation";
      id: string;
      agent: string;
      description: string;
      prompt: string;
    }
  | { type: "delegation_done"; id: string; isError: boolean }
  /** New provider-specific connection details, e.g. Claude's plan usage. */
  | { type: "usage"; provider: string; details: Record<string, unknown> }
  | {
      type: "done";
      isError: boolean;
      costUsd: number;
      durationMs: number;
      turns: number;
    }
  | { type: "error"; message: string };

export interface SendMessage {
  projectId: number;
  /** Catalog agent that answers; omitted, the model answers and may delegate to the project's agents. */
  agent?: string;
  message: string;
  attachments?: Attachment[];
  sessionId?: string;
  model?: string;
  /** One of the model's `efforts`; the model's default when omitted. */
  effort?: string;
  /** Workflow runs since the last turn, whose result the turn passes on to the model. */
  workflowRuns?: number[];
}

/** A conversation of the project, with its turn in progress if any. */
export interface SessionSummary {
  /** Null for a new conversation whose first turn hasn't got its id yet: open it by `runId`. */
  sessionId: string | null;
  provider: string;
  title: string;
  updatedAt: string;
  runId: number | null;
  /** Mission born from this conversation, if any. */
  missionId: number | null;
  activeRun: {
    runId: number;
    status: RunStatus;
    reason: WaitReason | null;
  } | null;
  /** Its last answer arrived after the user last looked. */
  unread: boolean;
}

export interface HistoryTool {
  name: string;
  target: string | null;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  /** Names and types only: the files' content isn't kept. */
  attachments: { name: string; mediaType: string }[];
  tools: HistoryTool[];
  delegations: {
    id: string;
    agent: string;
    description: string;
    prompt: string;
    text: string;
    tools: HistoryTool[];
    isError: boolean;
  }[];
  /** A user message: the workflow runs it passed on, shown before it. */
  workflowRuns: number[];
}

export interface SessionHistory {
  sessionId: string;
  provider: string;
  /** Finished turns only: a turn in progress is in `lastRun`, to follow. */
  messages: HistoryMessage[];
  /** Workflow runs no turn passed on yet: they come after the messages. */
  workflowRuns: number[];
  /** Mission born from this conversation, if any. */
  missionId: number | null;
  /** Model chosen for the latest turn (`<provider>:<model>`); null: the default one. */
  model: string | null;
  /** Effort chosen for the latest turn; null: the model's default. */
  effort: string | null;
  lastRun: {
    runId: number;
    status: RunStatus;
    input: string;
    /** The workflow runs the turn passes on, shown before it. */
    workflowRuns: number[];
  } | null;
}

export const chatApi = {
  sessions: (projectId: number) =>
    api<SessionSummary[]>(`/chat/sessions?projectId=${projectId}`),
  history: (projectId: number, sessionId: string) =>
    api<SessionHistory>(
      `/chat/sessions/${encodeURIComponent(sessionId)}?projectId=${projectId}`,
    ),
  workspace: (path: string) =>
    api<Workspace>("/chat/workspace", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  /** Queues the turn; follow it with runsApi.follow. 409 while the conversation has one going. */
  send: (body: SendMessage) =>
    api<{ runId: number }>("/chat/messages", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
