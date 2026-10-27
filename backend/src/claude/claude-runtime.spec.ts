import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Logger } from '@nestjs/common';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentPolicy } from '../agents/policy.js';
import type { AgentSpec } from '../catalog/catalog.js';
import type { Subagent } from '../providers/provider.js';
import {
  confine,
  subagentDefinitions,
  toEvents,
  turnState,
} from './claude-runtime.js';

const policy = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  files: 'write',
  tools: [],
  mcp: [],
  skills: [],
  ...over,
});

const subagent = (key: string, own: AgentPolicy): Subagent => ({
  agent: {
    key,
    description: `${key} agent`,
    enabledByDefault: true,
    permissions: own,
    prompt: 'x',
  } as AgentSpec,
  policy: own,
  systemPrompt: `you are ${key}`,
});

const reviewer = subagent('reviewer', policy({ files: 'read' }));

const events = (messages: unknown[]) => {
  const state = turnState();
  return messages.flatMap((m) => [...toEvents(m as SDKMessage, state)]);
};

describe('toEvents', () => {
  it('reports a delegation, its own work and its end', () => {
    expect(
      events([
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu1',
                name: 'Agent',
                input: {
                  subagent_type: 'reviewer',
                  description: 'Review',
                  prompt: 'Look at a.ts',
                },
              },
            ],
          },
        },
        {
          type: 'assistant',
          parent_tool_use_id: 'tu1',
          message: {
            content: [
              { type: 'text', text: 'Reading' },
              {
                type: 'tool_use',
                id: 'tu2',
                name: 'Read',
                input: { file_path: '/p/a.ts' },
              },
            ],
          },
        },
        {
          type: 'assistant',
          parent_tool_use_id: 'tu1',
          message: { content: [{ type: 'text', text: 'All good' }] },
        },
        {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        type: 'delegation',
        id: 'tu1',
        agent: 'reviewer',
        description: 'Review',
        prompt: 'Look at a.ts',
      },
      { type: 'text', text: 'Reading', delegation: 'tu1' },
      { type: 'tool', name: 'Read', target: '/p/a.ts', delegation: 'tu1' },
      { type: 'text', text: '\n\n', delegation: 'tu1' },
      { type: 'text', text: 'All good', delegation: 'tu1' },
      { type: 'delegation_done', id: 'tu1', isError: false },
    ]);
  });

  it('keeps streamed subagent text out of the main thread', () => {
    expect(
      events([
        {
          type: 'stream_event',
          parent_tool_use_id: 'tu1',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'sub' },
          },
        },
      ]),
    ).toEqual([]);
  });

  it('closes delegations left open when the turn ends', () => {
    const out = events([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: {} }],
        },
      },
      {
        type: 'result',
        is_error: true,
        total_cost_usd: 0,
        duration_ms: 1,
        num_turns: 1,
      },
    ]);
    expect(out).toContainEqual({
      type: 'delegation_done',
      id: 'tu1',
      isError: true,
    });
    expect(out.at(-1)?.type).toBe('done');
  });
});

describe('subagentDefinitions', () => {
  it('hides what the main thread has and the subagent may not use', () => {
    const main = policy({ tools: ['clock'], mcp: ['docs'], skills: ['s'] });
    const defs = subagentDefinitions(main, [reviewer]);
    expect(defs.reviewer.disallowedTools).toEqual(
      expect.arrayContaining([
        'Agent',
        'Write',
        'Edit',
        'Skill',
        'mcp__app__clock',
        'mcp__docs',
      ]),
    );
    expect(defs.reviewer.disallowedTools).not.toContain('Read');
    expect(defs.reviewer.model).toBe('inherit');
  });
});

describe('confine', () => {
  let cwd: string;
  let guard: ReturnType<typeof confine>;
  const logger = new Logger('test');
  vi.spyOn(logger, 'warn').mockImplementation(() => {});

  const hook = async (name: string, input: unknown) => {
    const [matcher] = guard.hooks![name as 'PreToolUse']!;
    return matcher.hooks[0](input as never, undefined, {
      signal: new AbortController().signal,
    });
  };
  const decision = async (tool: string, input: unknown, agentId?: string) => {
    const out = (await hook('PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: input,
      agent_id: agentId,
    })) as { hookSpecificOutput?: Record<string, unknown> };
    return out.hookSpecificOutput ?? {};
  };

  beforeAll(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'ws-sub-')));
    guard = confine(cwd, policy(), logger, [reviewer]);
    await hook('SubagentStart', {
      hook_event_name: 'SubagentStart',
      agent_id: 'a1',
      agent_type: 'reviewer',
    });
  });

  it('lets the main thread delegate to a project agent, in the foreground', async () => {
    const out = await decision('Agent', {
      subagent_type: 'reviewer',
      prompt: 'x',
    });
    expect(out.permissionDecision).toBe('allow');
    expect(out.updatedInput).toMatchObject({ run_in_background: false });
  });

  it('refuses unknown agents and nested delegation', async () => {
    expect(
      (await decision('Agent', { subagent_type: 'general-purpose' }))
        .permissionDecision,
    ).toBe('deny');
    expect(
      (await decision('Agent', { subagent_type: 'reviewer' }, 'a1'))
        .permissionDecision,
    ).toBe('deny');
  });

  it("applies the subagent's own policy to its calls", async () => {
    const file = join(cwd, 'a.txt');
    expect(
      (await decision('Write', { file_path: file, content: '' }))
        .permissionDecision,
    ).toBeUndefined();
    expect(
      (await decision('Write', { file_path: file, content: '' }, 'a1'))
        .permissionDecision,
    ).toBe('deny');
    expect(
      (await decision('Read', { file_path: file }, 'a1')).permissionDecision,
    ).toBeUndefined();
    expect(
      (await decision('Read', { file_path: file }, 'unknown'))
        .permissionDecision,
    ).toBe('deny');
  });
});
