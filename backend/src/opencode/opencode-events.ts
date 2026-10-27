import type { ChatEvent } from '../providers/provider.js';

/** One event of OpenCode's `/api/event` stream. */
export interface OpencodeEvent {
  type: string;
  data?: Record<string, any>;
}

type Done = Extract<ChatEvent, { type: 'done' }>;

/** Turns the OpenCode events of one session's turn into chat events. */
export class TurnEvents {
  private readonly toolNames = new Map<string, string>();
  private readonly started = Date.now();
  private wroteText = false;
  private costUsd = 0;
  private turns = 0;
  /** Set once the turn is over. */
  finished = false;

  constructor(private readonly sessionId: string) {}

  /** Whether the event belongs to this turn's session (the stream carries every session's). */
  concerns(event: OpencodeEvent) {
    return event.data?.sessionID === this.sessionId;
  }

  *map(event: OpencodeEvent): Generator<ChatEvent> {
    const data = event.data ?? {};
    switch (event.type) {
      case 'session.text.started':
        if (this.wroteText) yield { type: 'text', text: '\n\n' };
        return;
      case 'session.text.delta':
        if (typeof data.delta === 'string' && data.delta) {
          this.wroteText = true;
          yield { type: 'text', text: data.delta };
        }
        return;
      case 'session.tool.input.started':
        this.toolNames.set(data.id, data.name);
        return;
      case 'session.tool.called': {
        const input = (data.input ?? {}) as Record<string, unknown>;
        const target = input.path ?? input.pattern ?? null;
        yield {
          type: 'tool',
          name: this.toolNames.get(data.id) ?? 'tool',
          target: typeof target === 'string' ? target : null,
        };
        return;
      }
      case 'session.step.ended':
        this.turns++;
        if (typeof data.cost === 'number') this.costUsd += data.cost;
        return;
      case 'session.execution.succeeded':
        yield this.done(false);
        return;
      case 'session.execution.failed':
        yield {
          type: 'error',
          message: `OpenCode: ${data.error?.message ?? 'esecuzione non riuscita'}`,
        };
        yield this.done(true);
        return;
      case 'session.execution.interrupted':
        yield this.done(true);
        return;
    }
  }

  private done(isError: boolean): Done {
    this.finished = true;
    return {
      type: 'done',
      isError,
      costUsd: this.costUsd,
      durationMs: Date.now() - this.started,
      turns: this.turns,
    };
  }
}
