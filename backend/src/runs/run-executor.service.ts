import { Injectable, Logger } from '@nestjs/common';
import type { Run } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RunEventBus } from './run-event-bus.js';
import { RunFiles } from './run-files.js';
import { RunHandlers } from './run-handlers.js';
import type {
  RunActivity,
  RunEventData,
  RunStatus,
  SequencedEvent,
} from './run-types.js';
import { TextCoalescer } from './text-coalescer.js';

const HEARTBEAT_MS = 10_000;
/** Lists hear about a run's activity at most this often. */
const ACTIVITY_MS = 2_000;
/** After the grace period, how long stopped runs get to wind down. */
const STOP_WAIT_MS = 5_000;

interface Execution {
  controller: AbortController;
  /** Why it was stopped: the user, or the backend shutting down. */
  stoppedBy: 'user' | 'shutdown' | null;
  done: Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/** What a list shows as the run's last action. */
function describe(event: RunEventData): string | null {
  if (event.type === 'tool')
    return event.target ? `${event.name} ${event.target}` : event.name;
  if (event.type === 'delegation') return `→ ${event.agent}`;
  return null;
}

/** Executes runs the scheduler hands it, for as long as the process lives: no request owns them. */
@Injectable()
export class RunExecutorService {
  private readonly logger = new Logger(RunExecutorService.name);
  private readonly executions = new Map<number, Execution>();
  private readonly activities = new Map<number, RunActivity>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: RunEventBus,
    private readonly handlers: RunHandlers,
    private readonly files: RunFiles,
  ) {}

  isExecuting(runId: number) {
    return this.executions.has(runId);
  }

  activity(runId: number): RunActivity | null {
    return this.activities.get(runId) ?? null;
  }

  /** Starts `run`, already marked running; `onEnd` runs once it has a final status. */
  start(run: Run, onEnd: () => void) {
    const execution: Execution = {
      controller: new AbortController(),
      stoppedBy: null,
      done: Promise.resolve(),
    };
    this.executions.set(run.id, execution);
    execution.done = this.execute(run, execution)
      .catch((error: unknown) =>
        this.logger.error(
          `Run ${run.id} could not be closed: ${String(error)}`,
        ),
      )
      .finally(() => {
        this.executions.delete(run.id);
        this.activities.delete(run.id);
        onEnd();
      });
  }

  /** Stops a run executing here; false when it isn't. */
  stop(runId: number, by: 'user' | 'shutdown' = 'user') {
    const execution = this.executions.get(runId);
    if (!execution) return false;
    execution.stoppedBy ??= by;
    execution.controller.abort();
    return true;
  }

  /** Waits for running runs up to `graceMs`, then stops the rest as interrupted. */
  async drain(graceMs: number) {
    const done = () => [...this.executions.values()].map((e) => e.done);
    await Promise.race([Promise.all(done()), sleep(graceMs)]);
    for (const id of this.executions.keys()) this.stop(id, 'shutdown');
    await Promise.race([Promise.all(done()), sleep(STOP_WAIT_MS)]);
  }

  private async execute(run: Run, execution: Execution) {
    const { signal } = execution.controller;
    // A run back from waiting goes on with its log; anything else starts it.
    const last = await this.prisma.runEvent.aggregate({
      where: { runId: run.id },
      _max: { seq: true },
    });
    let seq = last._max.seq ?? 0;
    let writes = Promise.resolve();
    // Stored first, then published: whatever a client sees live is already in the log.
    const emit = (data: RunEventData) => {
      const event: SequencedEvent = { seq: ++seq, data };
      writes = writes
        .then(() =>
          this.prisma.runEvent.create({
            data: {
              runId: run.id,
              seq: event.seq,
              dataJson: JSON.stringify(data),
            },
          }),
        )
        .then(
          () => this.bus.publish(run.id, event),
          (error: unknown) =>
            this.logger.warn(
              `Run ${run.id} event ${event.seq} not stored: ${String(error)}`,
            ),
        );
    };
    const coalescer = new TextCoalescer(emit);
    const heartbeat = setInterval(() => {
      this.prisma.run
        .update({ where: { id: run.id }, data: { heartbeatAt: new Date() } })
        .catch(() => undefined);
    }, HEARTBEAT_MS);

    let status: RunStatus = 'failed';
    let error: string | null = null;
    let costUsd = 0;
    try {
      const events = this.handlers.get(run.kind).execute(run, signal);
      for (;;) {
        const next = await events.next();
        if (next.done) {
          status = next.value;
          break;
        }
        const event = next.value;
        if (event.type === 'done') costUsd += event.costUsd;
        if (event.type === 'error') error = event.message;
        if (event.type === 'session') await this.sessionStarted(run, event);
        this.track(run, event);
        coalescer.push(event);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      coalescer.push({ type: 'error', message: error });
      status = 'failed';
    } finally {
      clearInterval(heartbeat);
    }
    if (signal.aborted) {
      status = execution.stoppedBy === 'shutdown' ? 'interrupted' : 'aborted';
      error =
        status === 'interrupted' ? "Backend spento durante l'esecuzione" : null;
    }
    if (status === 'done' || status === 'waiting') error = null;

    // Waiting isn't an end: clients keep following until it runs again.
    if (status !== 'waiting') coalescer.push({ type: 'finished', status });
    else coalescer.flush();
    await writes;
    await this.prisma.run.update({
      where: { id: run.id },
      data: {
        status,
        error,
        // A run back from waiting adds to what it spent before.
        costUsd: { increment: costUsd },
        finishedAt: status === 'waiting' ? null : new Date(),
        heartbeatAt: null,
      },
    });
    if (status === 'waiting') {
      this.bus.notify(run.userId, { type: 'changed', runId: run.id });
      return;
    }
    this.bus.end(run.id);
    this.bus.notify(run.userId, { type: 'changed', runId: run.id });
    if (run.kind === 'chat' && run.sessionId) {
      // The conversation may later become a mission, which starts from these files.
      const attachments = await this.files.attachments(run.id);
      if (attachments.length) {
        await this.files.saveSession(run.sessionId, attachments).catch(() => undefined);
      }
    }
    await this.files.remove(run.id);
  }

  /** A new conversation got its id: the run now belongs to it. */
  private async sessionStarted(
    run: Run,
    event: Extract<RunEventData, { type: 'session' }>,
  ) {
    if (run.kind !== 'chat' || run.sessionId === event.sessionId) return;
    run.sessionId = event.sessionId;
    await this.prisma.run.update({
      where: { id: run.id },
      data: { sessionId: event.sessionId, provider: event.provider },
    });
    this.bus.notify(run.userId, { type: 'changed', runId: run.id });
  }

  private readonly lastNotice = new Map<number, number>();
  private readonly pendingNotice = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();

  /** Keeps the run's activity and tells lists, at most every ACTIVITY_MS. */
  private track(run: Run, event: RunEventData) {
    const current = this.activities.get(run.id) ?? { step: null, last: null };
    let next = current;
    if (event.type === 'step_started' || event.type === 'iteration_started') {
      next = { step: { id: event.id, agent: event.agent }, last: null };
    } else {
      const last = describe(event);
      if (last) next = { ...current, last };
    }
    if (next === current) return;
    this.activities.set(run.id, next);

    const notify = () => {
      this.pendingNotice.delete(run.id);
      this.lastNotice.set(run.id, Date.now());
      const activity = this.activities.get(run.id);
      if (activity) {
        this.bus.notify(run.userId, {
          type: 'activity',
          runId: run.id,
          activity,
        });
      } else {
        this.lastNotice.delete(run.id);
      }
    };
    if (this.pendingNotice.has(run.id)) return;
    const wait = (this.lastNotice.get(run.id) ?? 0) + ACTIVITY_MS - Date.now();
    if (wait <= 0) notify();
    else this.pendingNotice.set(run.id, setTimeout(notify, wait));
  }
}
