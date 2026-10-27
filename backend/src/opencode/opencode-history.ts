import { HistoryBuilder, joinText } from '../providers/history.js';
import type { HistoryMessage, ToolCall } from '../providers/provider.js';
import { target } from './opencode-events.js';
import { SUBAGENT_ACTION, subagentKey } from './opencode-policy.js';

/** One entry of `/api/session/{id}/message`; only users' and assistants' matter here. */
export interface OpencodeMessage {
  type: string;
  text?: string;
  files?: { name?: string; mime?: string; uri?: string }[];
  content?: Part[];
}

type Part = Record<string, any>;

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** The child session a subagent call ran in, when OpenCode recorded it. */
export function childSession(part: Part): string | null {
  const id = part.state?.metadata?.sessionID;
  return typeof id === 'string' ? id : null;
}

/** Subagent calls of the conversation, which `toHistory` wants the child sessions of. */
export function subagentCalls(messages: OpencodeMessage[]): Part[] {
  return messages.flatMap((m) =>
    m.type === 'assistant'
      ? (m.content ?? []).filter(
          (p) => p.type === 'tool' && p.name === SUBAGENT_ACTION,
        )
      : [],
  );
}

function mediaType(file: { mime?: string; uri?: string }) {
  return file.mime ?? /^data:([^;,]+)/.exec(file.uri ?? '')?.[1] ?? '';
}

/** What an assistant's parts wrote and the tools they called. */
function work(messages: OpencodeMessage[]) {
  const texts: string[] = [];
  const tools: ToolCall[] = [];
  for (const m of messages) {
    if (m.type !== 'assistant') continue;
    for (const part of m.content ?? []) {
      if (part.type === 'text') texts.push(text(part.text));
      if (part.type === 'tool') {
        tools.push({
          name: text(part.name) || 'tool',
          target: target(part.state?.input ?? {}),
        });
      }
    }
  }
  return { text: joinText(texts), tools };
}

/**
 * The messages of a past OpenCode conversation as the chat shows them.
 * `children` holds the messages of each subagent call's child session, by
 * the id of the call.
 */
export function toHistory(
  messages: OpencodeMessage[],
  children: Map<string, OpencodeMessage[]> = new Map(),
): HistoryMessage[] {
  const history = new HistoryBuilder();
  for (const m of messages) {
    if (m.type === 'user') {
      history.user(
        text(m.text),
        (m.files ?? []).map((f) => ({
          name: f.name ?? 'file',
          mediaType: mediaType(f),
        })),
      );
      continue;
    }
    if (m.type !== 'assistant') continue;
    for (const part of m.content ?? []) {
      if (part.type === 'text' && part.text) history.text(part.text);
      if (part.type !== 'tool') continue;
      const input = (part.state?.input ?? {}) as Record<string, unknown>;
      if (part.name !== SUBAGENT_ACTION) {
        history.tool({
          name: text(part.name) || 'tool',
          target: target(input),
        });
        continue;
      }
      const child = children.get(part.id);
      // Without its child session, the call's own result is what the subagent answered.
      const done = child
        ? work(child)
        : {
            text: joinText(
              ((part.state?.content ?? []) as Part[])
                .filter((c) => c.type === 'text')
                .map((c) => text(c.text)),
            ),
            tools: [],
          };
      history.delegation({
        id: text(part.id),
        agent: subagentKey(text(input.agent)) ?? text(input.agent),
        description: text(input.description),
        prompt: text(input.prompt),
        ...done,
        isError: part.state?.status !== 'completed',
      });
    }
  }
  return history.messages;
}
