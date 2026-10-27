import type {
  HistoryDelegation,
  HistoryMessage,
  ToolCall,
} from './provider.js';

/** Pieces of text, separated like the live chat separates them. */
export function joinText(parts: string[]) {
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Builds a past conversation as the chat shows it: one message per user turn
 * and one reply gathering everything the model did until the next turn. A
 * provider only walks its own records and reports what it finds.
 */
export class HistoryBuilder {
  readonly messages: HistoryMessage[] = [];

  user(text: string, attachments: HistoryMessage['attachments'] = []) {
    this.messages.push({
      role: 'user',
      text,
      attachments,
      tools: [],
      delegations: [],
    });
  }

  text(text: string) {
    const reply = this.reply();
    reply.text = joinText([reply.text, text]);
  }

  tool(call: ToolCall) {
    this.reply().tools.push(call);
  }

  delegation(delegation: HistoryDelegation) {
    this.reply().delegations.push(delegation);
  }

  /** The reply to the last turn, started if the model hasn't done anything yet. */
  private reply(): HistoryMessage {
    const last = this.messages.at(-1);
    if (last?.role === 'assistant') return last;
    const reply: HistoryMessage = {
      role: 'assistant',
      text: '',
      attachments: [],
      tools: [],
      delegations: [],
    };
    this.messages.push(reply);
    return reply;
  }
}
