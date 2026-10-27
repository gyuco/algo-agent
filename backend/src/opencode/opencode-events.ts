import type { ChatEvent } from '../providers/provider.js';
import { SUBAGENT_ACTION, subagentKey } from './opencode-policy.js';

/** One event of OpenCode's `/api/event` stream. */
export interface OpencodeEvent {
  type: string;
  data?: Record<string, any>;
}

type Done = Extract<ChatEvent, { type: 'done' }>;

/** A child session a subagent runs in, and the delegation (tool call) it works for. */
interface Child {
  agent: string;
  delegation: string | null;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * Turns the OpenCode events of one session's turn into chat events. A
 * subagent the main session starts runs in a child session: its events are
 * followed too, tagged with the delegation (the main session's tool call).
 */
export class TurnEvents {
  private readonly toolNames = new Map<string, string>();
  private readonly started = Date.now();
  /** Threads that already wrote text: '' for the main one, else the delegation id. */
  private readonly wroteText = new Set<string>();
  /** Child sessions by id. */
  private readonly children = new Map<string, Child>();
  /** Delegations started and not finished, with the catalog key of their agent. */
  private readonly delegations = new Map<string, string>();
  private costUsd = 0;
  private turns = 0;
  /** Set once the turn is over. */
  finished = false;

  constructor(private readonly sessionId: string) {}

  /** Whether the event belongs to this turn: the main session's, or one of its subagents'. */
  concerns(event: OpencodeEvent) {
    const session = event.data?.sessionID;
    return (
      session === this.sessionId ||
      this.children.has(session) ||
      (event.type === 'session.created' &&
        event.data?.parentID === this.sessionId)
    );
  }

  /** Catalog key of the agent a child session runs; null for the main session. */
  agentOf(sessionId: string): string | null | undefined {
    if (sessionId === this.sessionId) return null;
    return this.children.get(sessionId)?.agent;
  }

  *map(event: OpencodeEvent): Generator<ChatEvent> {
    const data = event.data ?? {};
    if (event.type === 'session.created') {
      this.adopt(data);
      return;
    }
    if (data.sessionID !== this.sessionId) {
      yield* this.mapChild(event);
      return;
    }
    switch (event.type) {
      case 'session.text.started':
        if (this.wroteText.has('')) yield { type: 'text', text: '\n\n' };
        return;
      case 'session.text.delta':
        if (typeof data.delta === 'string' && data.delta) {
          this.wroteText.add('');
          yield { type: 'text', text: data.delta };
        }
        return;
      case 'session.tool.input.started':
        this.toolNames.set(data.id, data.name);
        return;
      case 'session.tool.called': {
        const input = (data.input ?? {}) as Record<string, unknown>;
        const name = this.toolNames.get(data.id) ?? 'tool';
        if (name === SUBAGENT_ACTION) {
          const agent = subagentKey(text(input.agent)) ?? text(input.agent);
          this.delegations.set(data.id, agent);
          yield {
            type: 'delegation',
            id: data.id,
            agent,
            description: text(input.description),
            prompt: text(input.prompt),
          };
          return;
        }
        yield { type: 'tool', name, target: target(input) };
        return;
      }
      case 'session.tool.progress': {
        // The subagent tool reports its child session as soon as it exists.
        const child = this.children.get(data.metadata?.sessionID);
        if (child && this.delegations.has(data.id)) child.delegation = data.id;
        return;
      }
      case 'session.tool.success':
      case 'session.tool.failed':
        if (this.delegations.delete(data.id)) {
          yield {
            type: 'delegation_done',
            id: data.id,
            isError: event.type === 'session.tool.failed',
          };
        }
        return;
      case 'session.step.ended':
        this.turns++;
        this.addCost(data);
        return;
      case 'session.execution.succeeded':
        yield* this.done(false);
        return;
      case 'session.execution.failed':
        yield {
          type: 'error',
          message: `OpenCode: ${data.error?.message ?? 'esecuzione non riuscita'}`,
        };
        yield* this.done(true);
        return;
      case 'session.execution.interrupted':
        yield* this.done(true);
        return;
    }
  }

  /**
   * Follows a child session the main one started, linked to the oldest
   * delegation to that agent still without one; `session.tool.progress`
   * confirms the link when it comes.
   */
  private adopt(data: Record<string, any>) {
    if (data.parentID !== this.sessionId) return;
    const agent = subagentKey(text(data.agent)) ?? text(data.agent);
    const linked = new Set(
      [...this.children.values()].map((c) => c.delegation),
    );
    const delegation =
      [...this.delegations].find(
        ([id, key]) => key === agent && !linked.has(id),
      )?.[0] ?? null;
    this.children.set(data.sessionID, { agent, delegation });
  }

  /** A subagent's text and tool calls, tagged with its delegation. */
  private *mapChild(event: OpencodeEvent): Generator<ChatEvent> {
    const data = event.data ?? {};
    const child = this.children.get(data.sessionID);
    const delegation = child?.delegation;
    if (!delegation) return;
    switch (event.type) {
      case 'session.text.started':
        if (this.wroteText.has(delegation)) {
          yield { type: 'text', text: '\n\n', delegation };
        }
        return;
      case 'session.text.delta':
        if (typeof data.delta === 'string' && data.delta) {
          this.wroteText.add(delegation);
          yield { type: 'text', text: data.delta, delegation };
        }
        return;
      case 'session.tool.input.started':
        this.toolNames.set(data.id, data.name);
        return;
      case 'session.tool.called':
        yield {
          type: 'tool',
          name: this.toolNames.get(data.id) ?? 'tool',
          target: target((data.input ?? {}) as Record<string, unknown>),
          delegation,
        };
        return;
      case 'session.step.ended':
        this.addCost(data);
        return;
    }
  }

  private addCost(data: Record<string, any>) {
    if (typeof data.cost === 'number') this.costUsd += data.cost;
  }

  private *done(isError: boolean): Generator<ChatEvent> {
    this.finished = true;
    // Whatever didn't report back by now won't: close it.
    for (const id of this.delegations.keys()) {
      yield { type: 'delegation_done', id, isError: true };
    }
    this.delegations.clear();
    const done: Done = {
      type: 'done',
      isError,
      costUsd: this.costUsd,
      durationMs: Date.now() - this.started,
      turns: this.turns,
    };
    yield done;
  }
}

function target(input: Record<string, unknown>) {
  const value = input.path ?? input.pattern ?? null;
  return typeof value === 'string' ? value : null;
}
