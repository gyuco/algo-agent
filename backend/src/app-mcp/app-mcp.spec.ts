import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  handleRpc,
  type AppToolDefinition,
  type RpcRequest,
} from './app-mcp.js';

const echo = tool(
  'echo',
  'Echoes its text.',
  { text: z.string() },
  async ({ text }) => ({ content: [{ type: 'text', text }] }),
);
const broken = tool('broken', 'Always fails.', {}, async () => {
  throw new Error('boom');
});
const tools = [echo, broken] as AppToolDefinition[];

const rpc = (method: string, params?: Record<string, unknown>, id = 1) =>
  handleRpc(tools, { jsonrpc: '2.0', id, method, params } as RpcRequest);

describe('handleRpc', () => {
  it('echoes the client protocol version on initialize', async () => {
    expect(await rpc('initialize', { protocolVersion: '2025-11-25' })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'app', version: '1.0.0' },
      },
    });
  });

  it('does not answer notifications', async () => {
    expect(
      await handleRpc(tools, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    ).toBeNull();
  });

  it('lists tools with a JSON schema of their input', async () => {
    const res = (await rpc('tools/list')) as { result: { tools: any[] } };
    expect(res.result.tools[0]).toMatchObject({
      name: 'echo',
      description: 'Echoes its text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    });
  });

  it('calls a tool with validated arguments', async () => {
    expect(
      await rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } }),
    ).toMatchObject({ result: { content: [{ type: 'text', text: 'hi' }] } });
    expect(
      await rpc('tools/call', { name: 'echo', arguments: { text: 1 } }),
    ).toMatchObject({ result: { isError: true } });
  });

  it('reports a failing tool as a tool error, not a protocol error', async () => {
    expect(await rpc('tools/call', { name: 'broken' })).toMatchObject({
      result: { isError: true, content: [{ text: 'boom' }] },
    });
  });

  it('rejects unknown tools and methods', async () => {
    expect(await rpc('tools/call', { name: 'nope' })).toMatchObject({
      error: { code: -32602 },
    });
    expect(await rpc('resources/list')).toMatchObject({
      error: { code: -32601 },
    });
  });
});
