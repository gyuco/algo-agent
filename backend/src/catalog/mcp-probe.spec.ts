import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeMcp } from './mcp-probe.js';

/** An MCP server over HTTP that wants `Authorization: Bearer good`. */
function mcpServer(): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer good') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"Token MCP mancante"}');
        return;
      }
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        message.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: {} }
          : { tools: [{ name: 'list_tasks' }, { name: 'add_task' }] };
      // Answered as an event stream, as many servers do.
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'mcp-session-id': 's1',
      });
      res.end(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`,
      );
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

describe('probeMcp', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = await mcpServer();
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => server.close());

  const spec = (headers: Record<string, string>) =>
    ({
      key: 'planner',
      type: 'http',
      url,
      headers,
      description: '',
      enabledByDefault: false,
    }) as const;

  it('lists the tools with the headers filled from the variables', async () => {
    expect(
      await probeMcp(spec({ Authorization: 'Bearer ${TOKEN}' }), {
        TOKEN: 'good',
      }),
    ).toEqual({ ok: true, tools: ['list_tasks', 'add_task'] });
  });

  it('says the credentials were refused', async () => {
    const result = await probeMcp(spec({}), {});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('HTTP 401');
  });

  it('reports a missing secret', async () => {
    const result = await probeMcp(spec({ Authorization: '${NOPE}' }), {});
    expect(!result.ok && result.error).toContain('segreto NOPE non impostato');
  });

  it('runs a stdio server', async () => {
    const script = `
      require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
        const m = JSON.parse(l);
        if (m.id === undefined) return;
        const result = m.method === 'initialize' ? {} : { tools: [{ name: 'echo' }] };
        console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      });`;
    expect(
      await probeMcp(
        {
          key: 'echo',
          type: 'stdio',
          command: process.execPath,
          args: ['-e', script],
          env: {},
          description: '',
          enabledByDefault: false,
        },
        {},
      ),
    ).toEqual({ ok: true, tools: ['echo'] });
  });
});
