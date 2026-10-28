import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { McpSpec } from './catalog.js';
import { interpolate } from './runtime.js';

const TIMEOUT_MS = 15_000;
const PROTOCOL_VERSION = '2025-06-18';
/** How much of a failed response or of stderr goes in the error. */
const DETAIL_CHARS = 300;

export type ProbeResult =
  { ok: true; tools: string[] } | { ok: false; error: string };

type RpcMessage = {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
};

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'algo-agent', version: '1.0.0' },
  },
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const LIST_TOOLS = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

function resultOf(message: RpcMessage) {
  if (message.error) {
    throw new Error(
      `errore MCP ${message.error.code}: ${message.error.message}`,
    );
  }
  return message.result;
}

function toolNames(result: unknown): string[] {
  const tools = (result as { tools?: { name: string }[] } | undefined)?.tools;
  return (tools ?? []).map((t) => t.name);
}

/**
 * Connects to an MCP server as a run would, with the run's variables, and
 * lists its tools: a failure says why (unreachable, refused credentials…).
 */
export async function probeMcp(
  spec: McpSpec,
  variables: Record<string, string>,
): Promise<ProbeResult> {
  try {
    const tools =
      spec.type === 'stdio'
        ? await probeStdio(
            spec.command,
            spec.args,
            interpolate(spec.env, spec.key, variables),
          )
        : await probeHttp(
            spec.url,
            interpolate(spec.headers, spec.key, variables),
          );
    return { ok: true, tools };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The JSON-RPC response with `id`, from a JSON or an event-stream body. */
async function rpcResponse(res: Response, id: number): Promise<RpcMessage> {
  const body = await res.text();
  const messages = res.headers
    .get('content-type')
    ?.includes('text/event-stream')
    ? body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5)) as RpcMessage)
    : [JSON.parse(body) as RpcMessage];
  const message = messages.find((m) => m.id === id);
  if (!message) throw new Error('risposta MCP senza esito');
  return message;
}

async function probeHttp(url: string, headers: Record<string, string>) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let session: string | null = null;
  const post = async (message: object) => {
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session && {
          'mcp-session-id': session,
          'mcp-protocol-version': PROTOCOL_VERSION,
        }),
      },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, DETAIL_CHARS);
      const hint =
        res.status === 401 || res.status === 403
          ? " (credenziali rifiutate: controlla l'header Authorization e il segreto che usa)"
          : '';
      throw new Error(`HTTP ${res.status}${hint}${detail && `: ${detail}`}`);
    }
    session = res.headers.get('mcp-session-id') ?? session;
    return res;
  };
  try {
    resultOf(await rpcResponse(await post(INITIALIZE), 1));
    await (await post(INITIALIZED)).body?.cancel();
    return toolNames(resultOf(await rpcResponse(await post(LIST_TOOLS), 2)));
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`nessuna risposta entro ${TIMEOUT_MS / 1000}s`);
    }
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    throw cause ? new Error(`${(error as Error).message}: ${cause}`) : error;
  }
}

function probeStdio(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let done = false;
    const finish = (error: Error | null, tools: string[] = []) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(tools);
    };
    const send = (message: object) =>
      child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(
      () => finish(new Error(`nessuna risposta entro ${TIMEOUT_MS / 1000}s`)),
      TIMEOUT_MS,
    );
    child.on('error', (error) => finish(error));
    child.stdin.on('error', () => {});
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-DETAIL_CHARS);
    });
    child.on('exit', (code) =>
      finish(
        new Error(
          `il comando è terminato (codice ${code})${stderr && `: ${stderr.trim()}`}`,
        ),
      ),
    );
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return; // Not protocol: a server logging to stdout.
      }
      try {
        if (message.id === 1) {
          resultOf(message);
          send(INITIALIZED);
          send(LIST_TOOLS);
        } else if (message.id === 2) {
          finish(null, toolNames(resultOf(message)));
        }
      } catch (error) {
        finish(error as Error);
      }
    });
    send(INITIALIZE);
  });
}
