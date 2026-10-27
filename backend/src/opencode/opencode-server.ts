import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { OpencodeEvent } from './opencode-events.js';

const START_TIMEOUT_MS = 20_000;

export class OpencodeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A private `opencode serve` for one run: bound to localhost, behind a random
 * password, and stopped with `close()`.
 */
export class OpencodeServer {
  private constructor(
    private readonly child: ChildProcess,
    readonly url: string,
    private readonly auth: string,
  ) {}

  static start(
    bin: string,
    cwd: string,
    env: Record<string, string>,
  ): Promise<OpencodeServer> {
    const password = randomBytes(24).toString('base64url');
    const child = spawn(
      bin,
      ['serve', '--hostname', '127.0.0.1', '--port', '0'],
      {
        cwd,
        env: { ...env, OPENCODE_SERVER_PASSWORD: password },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

    return new Promise((resolve, reject) => {
      let output = '';
      const fail = (message: string) => {
        clearTimeout(timer);
        child.kill();
        // The password line is the only secret OpenCode prints.
        const tail = output
          .replace(/server password.*/g, '')
          .trim()
          .slice(-500);
        reject(new Error(tail ? `${message}: ${tail}` : message));
      };
      const timer = setTimeout(
        () => fail('OpenCode non si è avviato in tempo'),
        START_TIMEOUT_MS,
      );
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const url = /server listening on (http:\/\/\S+)/.exec(output)?.[1];
        if (!url) return;
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        // Keep draining the pipes so the server never blocks on a full one.
        child.stdout?.resume();
        child.stderr?.resume();
        resolve(new OpencodeServer(child, url, auth));
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.on('error', (error) =>
        fail(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? `OpenCode non trovato (${bin}): installalo o imposta OPENCODE_BIN`
            : error.message,
        ),
      );
      child.on('exit', (code) => fail(`OpenCode è terminato (codice ${code})`));
    });
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url + path, {
      method,
      headers: { authorization: this.auth, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;
    if (!res.ok) {
      throw new OpencodeError(
        res.status,
        payload?.message ?? `OpenCode ha risposto ${res.status}`,
      );
    }
    return payload as T;
  }

  /** Subscribes to the event stream; resolves once it is open, so nothing sent afterwards is missed. */
  async events(signal: AbortSignal): Promise<AsyncGenerator<OpencodeEvent>> {
    const res = await fetch(`${this.url}/api/event`, {
      headers: { authorization: this.auth, accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) {
      throw new OpencodeError(res.status, 'Stream di eventi non disponibile');
    }
    return parseEvents(res.body);
  }

  close() {
    this.child.kill();
  }
}

/** Server-Sent Events whose data lines each carry one JSON event. */
async function* parseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OpencodeEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trimEnd();
      buffer = buffer.slice(end + 1);
      if (line.startsWith('data:')) {
        yield JSON.parse(line.slice(5)) as OpencodeEvent;
      }
    }
  }
}
