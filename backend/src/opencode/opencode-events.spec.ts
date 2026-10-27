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

  it('follows a subagent in its child session as part of its delegation', () => {
    const child = (type: string, data: Record<string, unknown> = {}) => ({
      type,
      data: { sessionID: 'ses_child', ...data },
    });
    const turn = new TurnEvents(SID);
    const events: OpencodeEvent[] = [
      ev('session.tool.input.started', { id: 'c1', name: 'subagent' }),
      ev('session.tool.called', {
        id: 'c1',
        input: {
          agent: 'agent_reviewer',
          description: 'Review',
          prompt: 'Look at a.ts',
        },
      }),
      {
        type: 'session.created',
        data: {
          sessionID: 'ses_child',
          parentID: SID,
          agent: 'agent_reviewer',
        },
      },
      ev('session.tool.progress', {
        id: 'c1',
        metadata: { sessionID: 'ses_child', status: 'running' },
      }),
      child('session.tool.input.started', { id: 'c2', name: 'read' }),
      child('session.tool.called', { id: 'c2', input: { path: 'a.ts' } }),
      child('session.text.started'),
      child('session.text.delta', { delta: 'All good' }),
      child('session.step.ended', { cost: 0.1 }),
      child('session.execution.succeeded'),
      ev('session.tool.success', { id: 'c1' }),
      ev('session.execution.succeeded'),
    ];
    const out: ChatEvent[] = [];
    for (const event of events) {
      expect(turn.concerns(event)).toBe(true);
      out.push(...turn.map(event));
    }
    expect(out.slice(0, -1)).toEqual([
      {
        type: 'delegation',
        id: 'c1',
        agent: 'reviewer',
        description: 'Review',
        prompt: 'Look at a.ts',
      },
      { type: 'tool', name: 'read', target: 'a.ts', delegation: 'c1' },
      { type: 'text', text: 'All good', delegation: 'c1' },
      { type: 'delegation_done', id: 'c1', isError: false },
    ]);
    // The child finishing doesn't end the turn; the main session does.
    expect(out.at(-1)).toMatchObject({ type: 'done', costUsd: 0.1 });
    expect(turn.agentOf('ses_child')).toBe('reviewer');
    expect(turn.agentOf(SID)).toBeNull();
    expect(turn.agentOf('ses_other')).toBeUndefined();
  });

  it('ignores sessions started by someone else', () => {
    const turn = new TurnEvents(SID);
    expect(
      turn.concerns({
        type: 'session.created',
        data: { sessionID: 'ses_x', parentID: 'ses_other' },
      }),
    ).toBe(false);
  });

  it('closes delegations left open when the turn ends', () => {
    const { out } = run([
      ev('session.tool.input.started', { id: 'c1', name: 'subagent' }),
      ev('session.tool.called', { id: 'c1', input: { agent: 'agent_a' } }),
      ev('session.execution.interrupted'),
    ]);
    expect(out).toContainEqual({
      type: 'delegation_done',
      id: 'c1',
      isError: true,
    });
    expect(out.at(-1)?.type).toBe('done');
  });
});
