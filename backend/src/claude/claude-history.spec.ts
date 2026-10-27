import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toHistory, TranscriptStore } from './claude-history.js';

const message = (
  type: 'user' | 'assistant',
  content: unknown,
  parent: string | null = null,
): SessionMessage => ({
  type,
  uuid: 'u',
  session_id: 's',
  message: { role: type, content },
  parent_tool_use_id: parent,
  parent_agent_id: null,
});

describe('toHistory', () => {
  it('gathers a turn into one reply, leaving tool results out', () => {
    const history = toHistory([
      message('user', 'leggi il README'),
      message('assistant', [
        { type: 'thinking', thinking: '' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'Read',
          input: { file_path: '/p/README.md' },
        },
      ]),
      message('user', [
        { type: 'tool_result', tool_use_id: 't1', content: 'x' },
      ]),
      message('assistant', [{ type: 'text', text: 'Fatto.' }]),
      message('assistant', [{ type: 'text', text: 'Altro?' }]),
    ]);
    expect(history).toEqual([
      {
        role: 'user',
        text: 'leggi il README',
        attachments: [],
        tools: [],
        delegations: [],
      },
      {
        role: 'assistant',
        text: 'Fatto.\n\nAltro?',
        attachments: [],
        tools: [{ name: 'Read', target: '/p/README.md' }],
        delegations: [],
      },
    ]);
  });

  it('keeps attachment names and types, not their content', () => {
    const [user] = toHistory([
      message('user', [
        { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
        {
          type: 'document',
          title: 'spec.pdf',
          source: { type: 'base64', media_type: 'application/pdf' },
        },
        { type: 'text', text: 'guarda' },
      ]),
    ]);
    expect(user.attachments).toEqual([
      { name: 'image', mediaType: 'image/png' },
      { name: 'spec.pdf', mediaType: 'application/pdf' },
    ]);
    expect(user.text).toBe('guarda');
  });

  it("fills a delegation from the subagent's transcript and its result", () => {
    const [, reply] = toHistory(
      [
        message('user', 'delega'),
        message('assistant', [
          {
            type: 'tool_use',
            id: 'a1',
            name: 'Agent',
            input: { subagent_type: 'coder', description: 'd', prompt: 'p' },
          },
        ]),
        message('user', [
          { type: 'tool_result', tool_use_id: 'a1', is_error: true },
        ]),
      ],
      new Map([
        [
          'a1',
          [
            message('user', 'p'),
            message('assistant', [
              {
                type: 'tool_use',
                id: 'g',
                name: 'Glob',
                input: { pattern: '*' },
              },
            ]),
            message('assistant', [{ type: 'text', text: 'Elenco.' }]),
          ],
        ],
      ]),
    );
    expect(reply.tools).toEqual([]);
    expect(reply.delegations).toEqual([
      {
        id: 'a1',
        agent: 'coder',
        description: 'd',
        prompt: 'p',
        text: 'Elenco.',
        tools: [{ name: 'Glob', target: '*' }],
        isError: true,
      },
    ]);
  });
});

describe('TranscriptStore', () => {
  it('reads transcripts and refuses keys that leave its folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcripts-'));
    await mkdir(join(dir, 'projects', '-p'), { recursive: true });
    await writeFile(
      join(dir, 'projects', '-p', 's1.jsonl'),
      '{"type":"user","uuid":"a"}\n{"type":"assi',
    );
    const store = new TranscriptStore(dir);
    expect(await store.load({ projectKey: '-p', sessionId: 's1' })).toEqual([
      { type: 'user', uuid: 'a' },
    ]);
    expect(await store.load({ projectKey: '-p', sessionId: 'nope' })).toBe(
      null,
    );
    expect(await store.load({ projectKey: '..', sessionId: 's1' })).toBe(null);
    expect(
      await store.load({ projectKey: '-p', sessionId: 's1', subpath: '../x' }),
    ).toBe(null);
    expect(await store.listSessions('-p')).toEqual([
      { sessionId: 's1', mtime: expect.any(Number) },
    ]);
  });
});
