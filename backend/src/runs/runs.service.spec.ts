import type { PrismaService } from '../prisma/prisma.service.js';
import { RunEventBus } from './run-event-bus.js';
import type { RunExecutorService } from './run-executor.service.js';
import type { RunHandlers } from './run-handlers.js';
import type { RunLog } from './run-log.js';
import type { RunQueueService } from './run-queue.service.js';
import type { RunEventData, SequencedEvent } from './run-types.js';
import { RunsService } from './runs.service.js';

/** A run's log in memory, and a service reading it like the database. */
function setup(status = 'running') {
  const bus = new RunEventBus();
  const log: { seq: number; data: RunEventData }[] = [];
  const run = { id: 1, userId: 7, status };
  let beforeRead: () => void = () => undefined;
  const prisma = {
    run: {
      findFirst: vi.fn(
        ({ where }: { where: { id: number; userId: number } }) =>
          where.id === run.id && where.userId === run.userId
            ? { ...run }
            : null,
      ),
      findUnique: vi.fn(() => ({ status: run.status })),
    },
    runEvent: {
      findMany: vi.fn(({ where }: { where: { seq: { gt: number } } }) => {
        beforeRead();
        return log
          .filter((e) => e.seq > where.seq.gt)
          .map((e) => ({ seq: e.seq, dataJson: JSON.stringify(e.data) }));
      }),
    },
  };
  const executor = { isExecuting: () => run.status === 'running' };
  const service = new RunsService(
    prisma as unknown as PrismaService,
    bus,
    executor as unknown as RunExecutorService,
    {} as RunQueueService,
    {} as RunHandlers,
    {} as RunLog,
  );
  /** Stores an event, then publishes it, as the executor does. */
  const emit = (data: RunEventData) => {
    const event = { seq: log.length + 1, data };
    log.push(event);
    bus.publish(run.id, event);
  };
  return {
    run,
    emit,
    service,
    bus,
    onRead: (fn: () => void) => (beforeRead = fn),
  };
}

async function collect(events: AsyncIterable<SequencedEvent>) {
  const out: number[] = [];
  for await (const e of events) out.push(e.seq);
  return out;
}

describe('RunsService.follow', () => {
  it('sends stored events, then live ones, without repeats', async () => {
    const { emit, service, onRead } = setup();
    emit({ type: 'text', text: 'a' });
    emit({ type: 'text', text: 'b' });
    // An event stored while the log is being read reaches the client both ways.
    onRead(() => {
      onRead(() => undefined);
      emit({ type: 'tool', name: 'Read', target: null });
    });
    const seqs = collect(service.follow(7, 1, 0, new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));
    emit({ type: 'text', text: 'c' });
    emit({ type: 'finished', status: 'done' });
    expect(await seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it('starts after the cursor', async () => {
    const { emit, service, run } = setup();
    emit({ type: 'text', text: 'a' });
    emit({ type: 'text', text: 'b' });
    emit({ type: 'finished', status: 'done' });
    run.status = 'done';
    expect(
      await collect(service.follow(7, 1, 1, new AbortController().signal)),
    ).toEqual([2, 3]);
  });

  it('ends a finished run that has no log', async () => {
    const { service, run } = setup('interrupted');
    run.status = 'interrupted';
    const events: SequencedEvent[] = [];
    for await (const e of service.follow(7, 1, 0, new AbortController().signal))
      events.push(e);
    expect(events).toEqual([
      { seq: 0, data: { type: 'finished', status: 'interrupted' } },
    ]);
  });

  it("refuses another user's run", async () => {
    const { service } = setup();
    await expect(
      service.follow(8, 1, 0, new AbortController().signal).next(),
    ).rejects.toThrow('Esecuzione non trovata');
  });

  it('stops listening when the client goes away', async () => {
    const { service, bus } = setup();
    const abort = new AbortController();
    const seqs = collect(service.follow(7, 1, 0, abort.signal));
    await new Promise((r) => setTimeout(r, 0));
    abort.abort();
    expect(await seqs).toEqual([]);
    expect((bus as unknown as { runs: Map<number, unknown> }).runs.size).toBe(
      0,
    );
  });
});
