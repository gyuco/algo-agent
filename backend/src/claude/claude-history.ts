import {
  getSessionMessages,
  getSubagentMessages,
  type SessionKey,
  type SessionMessage,
  type SessionStore,
  type SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HistoryBuilder, joinText } from '../providers/history.js';
import type {
  HistoryDelegation,
  HistoryMessage,
  ToolCall,
} from '../providers/provider.js';
import { AGENT_TOOLS, toolTarget } from './claude-runtime.js';

/** Project keys and session ids are sanitized names; subpaths add `/` between them. No dots, so no way out. */
const NAME = /^[\w-]+$/;
const SUBPATH = /^[\w-]+(\/[\w-]+)*$/;

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Read-only access to the transcripts Claude Code wrote under one user's
 * config dir. The SDK's own readers only look in the process-wide one, so
 * they are pointed here through this store.
 */
export class TranscriptStore implements SessionStore {
  private readonly root: string;
  /** Project key of each session loaded, to find its subagents. */
  private readonly projects = new Map<string, string>();

  constructor(configDir: string) {
    this.root = join(configDir, 'projects');
  }

  append(): Promise<void> {
    return Promise.reject(new Error('Transcripts are read-only here'));
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    if (
      !NAME.test(key.projectKey) ||
      !NAME.test(key.sessionId) ||
      (key.subpath !== undefined && !SUBPATH.test(key.subpath))
    ) {
      return null;
    }
    const file = key.subpath
      ? join(this.root, key.projectKey, key.sessionId, `${key.subpath}.jsonl`)
      : join(this.root, key.projectKey, `${key.sessionId}.jsonl`);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    if (!key.subpath) this.projects.set(key.sessionId, key.projectKey);
    return raw.split('\n').flatMap((line) => {
      // The last line may be half written.
      try {
        return line ? [JSON.parse(line) as SessionStoreEntry] : [];
      } catch {
        return [];
      }
    });
  }

  async listSessions(projectKey: string) {
    if (!NAME.test(projectKey)) return [];
    const dir = join(this.root, projectKey);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    return Promise.all(
      names
        .filter((n) => n.endsWith('.jsonl'))
        .map(async (n) => ({
          sessionId: n.slice(0, -'.jsonl'.length),
          mtime: Math.floor((await stat(join(dir, n))).mtimeMs),
        })),
    );
  }

  /** The subagents of a session already loaded, by the tool call that started each. */
  async subagents(sessionId: string): Promise<Map<string, string>> {
    const subagents = new Map<string, string>();
    const projectKey = this.projects.get(sessionId);
    if (!projectKey) return subagents;
    const dir = join(this.root, projectKey, sessionId, 'subagents');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (missing(error)) return subagents;
      throw error;
    }
    for (const name of names) {
      const agentId = /^agent-([\w-]+)\.meta\.json$/.exec(name)?.[1];
      if (!agentId) continue;
      try {
        const meta = JSON.parse(await readFile(join(dir, name), 'utf8')) as {
          toolUseId?: unknown;
        };
        if (typeof meta.toolUseId === 'string') {
          subagents.set(meta.toolUseId, agentId);
        }
      } catch {
        // A subagent without readable metadata just shows no details.
      }
    }
    return subagents;
  }
}

type Block = Record<string, any>;

const text = (value: unknown) => (typeof value === 'string' ? value : '');

function blocks(message: SessionMessage): Block[] | string {
  const content = (message.message as { content?: unknown } | null)?.content;
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as Block[])
      : [];
}

/** What a subagent wrote and the tools it called, from its own transcript. */
function subagentWork(messages: SessionMessage[]) {
  const texts: string[] = [];
  const tools: ToolCall[] = [];
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    const content = blocks(message);
    if (typeof content === 'string') continue;
    for (const block of content) {
      if (block.type === 'text') texts.push(text(block.text));
      if (block.type === 'tool_use') {
        tools.push({ name: block.name, target: toolTarget(block.input ?? {}) });
      }
    }
  }
  return { text: joinText(texts), tools };
}

/**
 * The messages of a past conversation as the chat shows them. `subagents`
 * holds each delegation's transcript by the id of the tool call that started it.
 */
export function toHistory(
  messages: SessionMessage[],
  subagents: Map<string, SessionMessage[]> = new Map(),
): HistoryMessage[] {
  const history = new HistoryBuilder();
  const delegations = new Map<string, HistoryDelegation>();

  for (const message of messages) {
    if (message.parent_tool_use_id) continue;
    const content = blocks(message);
    if (message.type === 'user') {
      if (typeof content === 'string') {
        if (content) history.user(content);
        continue;
      }
      const results = content.filter((b) => b.type === 'tool_result');
      for (const result of results) {
        const delegation = delegations.get(result.tool_use_id);
        if (delegation) delegation.isError = result.is_error ?? false;
      }
      if (results.length === content.length) continue;
      const attachments = content
        .filter((b) => b.type === 'image' || b.type === 'document')
        .map((b) => ({
          name: text(b.title) || (b.type === 'image' ? 'image' : 'document'),
          mediaType: text(b.source?.media_type),
        }));
      const typed = joinText(
        content.filter((b) => b.type === 'text').map((b) => text(b.text)),
      );
      if (typed || attachments.length) history.user(typed, attachments);
      continue;
    }
    if (message.type !== 'assistant' || typeof content === 'string') continue;
    for (const block of content) {
      if (block.type === 'text' && block.text) history.text(block.text);
      if (block.type !== 'tool_use') continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (AGENT_TOOLS.includes(block.name)) {
        const delegation: HistoryDelegation = {
          id: block.id,
          agent: text(input.subagent_type),
          description: text(input.description),
          prompt: text(input.prompt),
          ...subagentWork(subagents.get(block.id) ?? []),
          isError: false,
        };
        delegations.set(block.id, delegation);
        history.delegation(delegation);
        continue;
      }
      history.tool({ name: block.name, target: toolTarget(input) });
    }
  }
  return history.messages;
}

/** A past conversation held in `cwd`, with the work of the agents it delegated to; null if there is none. */
export async function readHistory(
  store: TranscriptStore,
  cwd: string,
  sessionId: string,
): Promise<HistoryMessage[] | null> {
  const options = { dir: cwd, sessionStore: store };
  const messages = await getSessionMessages(sessionId, options);
  if (!messages.length) return null;
  const subagents = new Map<string, SessionMessage[]>();
  for (const [toolUseId, agentId] of await store.subagents(sessionId)) {
    subagents.set(
      toolUseId,
      await getSubagentMessages(sessionId, agentId, options),
    );
  }
  return toHistory(messages, subagents);
}
