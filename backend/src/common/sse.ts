import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

/**
 * Streams `events` as Server-Sent Events. The first event is awaited before the
 * stream starts, so validation and connection errors still come back as
 * normal HTTP errors.
 */
export async function sendEvents(
  res: Response,
  events: AsyncGenerator<unknown>,
) {
  const first = await events.next();

  res.status(HttpStatus.OK).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const write = (event: unknown) =>
    res.write(`data: ${JSON.stringify(event)}\n\n`);

  if (!first.done) write(first.value);
  for await (const event of events) write(event);
  res.end();
}

/** An abort signal that fires when the client goes away (closed the tab or pressed stop). */
export function closeSignal(res: Response): AbortSignal {
  const aborted = new AbortController();
  res.on('close', () => aborted.abort());
  return aborted.signal;
}
