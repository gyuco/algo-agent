import { toHistory, type OpencodeMessage } from './opencode-history.js';

const assistant = (...content: Record<string, unknown>[]): OpencodeMessage => ({
  type: 'assistant',
  content,
});

describe('toHistory', () => {
  it('gathers a turn into one reply and skips bookkeeping entries', () => {
    const history = toHistory([
      {
        type: 'user',
        text: 'ciao',
        files: [{ name: 'a.png', uri: 'data:image/png;base64,AA' }],
      },
      assistant(
        { type: 'reasoning', text: 'hmm' },
        {
          type: 'tool',
          id: 't',
          name: 'read',
          state: { status: 'completed', input: { path: '/p/a.ts' } },
        },
      ),
      assistant({ type: 'text', text: 'Ciao!' }),
      { type: 'idle' },
      { type: 'model-switched' },
    ]);
    expect(history).toEqual([
      {
        role: 'user',
        text: 'ciao',
        attachments: [{ name: 'a.png', mediaType: 'image/png' }],
        tools: [],
        delegations: [],
      },
      {
        role: 'assistant',
        text: 'Ciao!',
        attachments: [],
        tools: [{ name: 'read', target: '/p/a.ts' }],
        delegations: [],
      },
    ]);
  });

  it("shows a delegation from its child session, or else from the call's result", () => {
    const call = (id: string, status: string) => ({
      type: 'tool',
      id,
      name: 'subagent',
      state: {
        status,
        input: { agent: 'agent_coder', description: 'd', prompt: 'p' },
        content: [{ type: 'text', text: `risultato ${id}` }],
      },
    });
    const [, reply] = toHistory(
      [
        { type: 'user', text: 'delega' },
        assistant(call('c1', 'completed'), call('c2', 'failed')),
      ],
      new Map([
        [
          'c1',
          [
            assistant(
              {
                type: 'tool',
                name: 'glob',
                state: { input: { pattern: '*' } },
              },
              { type: 'text', text: 'Elenco.' },
            ),
          ],
        ],
      ]),
    );
    expect(reply.delegations).toEqual([
      {
        id: 'c1',
        agent: 'coder',
        description: 'd',
        prompt: 'p',
        text: 'Elenco.',
        tools: [{ name: 'glob', target: '*' }],
        isError: false,
      },
      {
        id: 'c2',
        agent: 'coder',
        description: 'd',
        prompt: 'p',
        text: 'risultato c2',
        tools: [],
        isError: true,
      },
    ]);
  });
});
