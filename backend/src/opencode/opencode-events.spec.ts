import type { ChatEvent } from '../providers/provider.js';
import { TurnEvents, type OpencodeEvent } from './opencode-events.js';

const SID = 'ses_1';
const ev = (
  type: string,
  data: Record<string, unknown> = {},
): OpencodeEvent => ({
  type,
  data: { sessionID: SID, ...data },
});

function run(events: OpencodeEvent[]) {
  const turn = new TurnEvents(SID);
  const out: ChatEvent[] = [];
  for (const event of events) out.push(...turn.map(event));
  return { turn, out };
}

describe('TurnEvents', () => {
  it('maps a tool call, text and the end of the turn', () => {
    const { turn, out } = run([
      ev('session.step.started'),
      ev('session.tool.input.started', { id: 'c0', name: 'read' }),
      ev('session.tool.called', { id: 'c0', input: { path: 'a.txt' } }),
      ev('session.step.ended', { cost: 0.25 }),
      ev('session.text.started'),
      ev('session.text.delta', { delta: 'Hel' }),
      ev('session.text.delta', { delta: 'lo' }),
      ev('session.text.started'),
      ev('session.text.delta', { delta: 'Bye' }),
      ev('session.step.ended', { cost: 0.5 }),
      ev('session.execution.succeeded'),
    ]);
    expect(out.slice(0, -1)).toEqual([
      { type: 'tool', name: 'read', target: 'a.txt' },
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'Bye' },
    ]);
    expect(out.at(-1)).toMatchObject({
      type: 'done',
      isError: false,
      costUsd: 0.75,
      turns: 2,
    });
    expect(turn.finished).toBe(true);
  });

  it('reports a failed execution as an error', () => {
    const { turn, out } = run([
      ev('session.execution.failed', {
        error: { type: 'provider.quota', message: 'Free usage limit reached' },
      }),
    ]);
    expect(out[0]).toEqual({
      type: 'error',
      message: 'OpenCode: Free usage limit reached',
    });
    expect(out[1]).toMatchObject({ type: 'done', isError: true });
    expect(turn.finished).toBe(true);
  });

  it('only concerns its own session', () => {
    const turn = new TurnEvents(SID);
    expect(turn.concerns(ev('session.text.delta'))).toBe(true);
    expect(
      turn.concerns({ type: 'session.text.delta', data: { sessionID: 'x' } }),
    ).toBe(false);
    expect(turn.concerns({ type: 'server.connected', data: {} })).toBe(false);
  });
});
