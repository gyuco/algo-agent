import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

/** An abort signal that fires when the client goes away. */
export function closeSignal(res: Response): AbortSignal {
  const aborted = new AbortController();
  res.on('close', () => aborted.abort());
  return aborted.signal;
}

/**
 * Opens a Server-Sent Events response at once and streams `events` until they
 * end or the client goes away. With `id`, each event carries it, so a client
 * can resume right after the last one it saw.
 */
export async function streamEvents<T>(
  res: Response,
  events: (signal: AbortSignal) => AsyncIterable<T>,
  id?: (event: T) => { id: number; data: unknown },
) {
  res.status(HttpStatus.OK).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  // Keeps idle streams (a queued run) from being cut by proxies.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  try {
    for await (const event of events(closeSignal(res))) {
      if (id) {
        const framed = id(event);
        res.write(`id: ${framed.id}\ndata: ${JSON.stringify(framed.data)}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
  } finally {
    clearInterval(ping);
    res.end();
  }
}
