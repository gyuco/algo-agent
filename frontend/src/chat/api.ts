import { api, apiStream } from "../api/client";
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
}

export const chatApi = {
  workspace: (path: string) =>
    api<Workspace>("/chat/workspace", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  send: (body: SendMessage, signal: AbortSignal) =>
    apiStream<ChatEvent>("/chat/messages", body, signal),
};
