import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { APP_SERVER } from '../agents/policy.js';

export type AppToolDefinition = SdkMcpToolDefinition<any>;

export interface RpcRequest {
  jsonrpc: '2.0';
  /** Absent for notifications, which get no response. */
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number; result: unknown }
  | {
      jsonrpc: '2.0';
      id: string | number | null;
      error: { code: number; message: string };
    };

/** Used when the client doesn't say which revision it speaks. */
const PROTOCOL_VERSION = '2025-06-18';

const failure = (message: string) => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/**
 * The MCP methods a tools-only server needs (initialize, ping, tools/list,
 * tools/call), answered for `tools`: the app's own tools, served to runtimes
 * that can't load them in-process.
 */
export async function handleRpc(
  tools: AppToolDefinition[],
  message: RpcRequest,
): Promise<RpcResponse | null> {
  const { id } = message;
  if (id === undefined || id === null) return null;
  const ok = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
  const error = (code: number, text: string): RpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message: text },
  });

  switch (message.method) {
    case 'initialize':
      return ok({
        protocolVersion:
          typeof message.params?.protocolVersion === 'string'
            ? message.params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: APP_SERVER, version: '1.0.0' },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(z.object(t.inputSchema)),
          ...(t.annotations && { annotations: t.annotations }),
        })),
      });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === message.params?.name);
      if (!tool) return error(-32602, `Unknown tool: ${message.params?.name}`);
      const args = z
        .object(tool.inputSchema)
        .safeParse(message.params?.arguments ?? {});
      if (!args.success) return ok(failure(args.error.message));
      try {
        return ok(await tool.handler(args.data, {}));
      } catch (err) {
        return ok(failure(err instanceof Error ? err.message : String(err)));
      }
    }
    default:
      return error(-32601, `Method not found: ${message.method}`);
  }
}
