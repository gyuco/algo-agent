import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Run } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { channel, RunEventBus, type RunNotice } from './run-event-bus.js';
import { RunExecutorService } from './run-executor.service.js';
import { RunHandlers } from './run-handlers.js';
import { RunLog } from './run-log.js';
import { RunQueueService } from './run-queue.service.js';
import { listSteps, readSteps } from './run-steps.js';
import {
  ACTIVE_STATUSES,
  isActive,
  type RunEventData,
  type RunStatus,
  type SequencedEvent,
} from './run-types.js';

/** Finished runs stay in the activity list this long. */
const RECENT_MS = 24 * 60 * 60 * 1000;

/** A run as the API returns it. */
export type RunView = ReturnType<RunsService['view']>;

/** What the user's activity stream sends. */
export type ActivityNotice =
  /** Sent first, once listening: reload the list, changes from now on arrive here. */
  | { type: 'ready' }
  | { type: 'run'; run: RunView }
  | Extract<RunNotice, { type: 'activity' }>;

/** Reading, following, stopping and resuming runs of either kind; each endpoint checks the run is the user's. */
@Injectable()
export class RunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: RunEventBus,
    private readonly executor: RunExecutorService,
    private readonly queue: RunQueueService,
    private readonly handlers: RunHandlers,
    private readonly log: RunLog,
  ) {}

  /** The user's run; another user's is reported missing, not forbidden. */
  async find(userId: number, id: number) {
    const run = await this.prisma.run.findFirst({
      where: { id, userId },
      include: { project: { select: { name: true } }, mission: { select: { title: true } } },
    });
    if (!run) throw new NotFoundException('Esecuzione non trovata');
    return run;
  }

  view(run: Run & { project?: { name: string } | null; mission?: { title: string } | null }) {
    const {
      stepsJson,
      specJson: _spec,
      project,
      mission,
      userId: _userId,
      workflowHash: _hash,
      heartbeatAt: _heartbeat,
      title,
      ...rest
    } = run;
    return {
      ...rest,
      title: mission?.title ?? title,
      projectName: project?.name ?? null,
      status: run.status as RunStatus,
      steps: listSteps(readSteps(stepsJson)),
      reason: run.status === 'queued' ? this.queue.reason(run.id) : null,
      activity:
        run.status === 'running' ? this.executor.activity(run.id) : null,
      unread: Boolean(
        run.finishedAt && (!run.seenAt || run.seenAt < run.finishedAt),
      ),
    };
  }

  async get(userId: number, id: number) {
    return this.view(await this.find(userId, id));
  }

  /** Everything still to finish in all the user's projects, and what finished in the last day. */
  async active(userId: number) {
    const runs = await this.prisma.run.findMany({
      where: {
        userId,
        OR: [
          { status: { in: ACTIVE_STATUSES } },
          { finishedAt: { gte: new Date(Date.now() - RECENT_MS) } },
        ],
      },
      include: { project: { select: { name: true } }, mission: { select: { title: true } } },
      orderBy: { id: 'desc' },
      take: 100,
    });
    return runs.map((r) => this.view(r));
  }

  /**
   * The run's events after `after`, stored ones first and then live ones,
   * without gaps or repeats; ends after `finished`.
   */
  async *follow(
    userId: number,
    id: number,
    after: number,
    signal: AbortSignal,
  ): AsyncGenerator<SequencedEvent> {
    await this.find(userId, id);
    // Listen before reading the log: an event stored meanwhile arrives both ways.
    const live = channel<SequencedEvent>(signal);
    live.onClose(this.bus.subscribe(id, (event) => live.push(event)));

    let last = after;
    const stored = await this.prisma.runEvent.findMany({
      where: { runId: id, seq: { gt: after } },
      orderBy: { seq: 'asc' },
    });
    for (const row of stored) {
      const data = JSON.parse(row.dataJson) as RunEventData;
      yield { seq: row.seq, data };
      last = row.seq;
      if (data.type === 'finished') return;
    }

    const run = await this.prisma.run.findUnique({
      where: { id },
      select: { status: true },
    });
    if (run && !isActive(run.status) && !this.executor.isExecuting(id)) {
      const ending = live.drain().find((e) => e.data.type === 'finished');
      // Older runs, or logs cleaned up, end without one: say how it ended.
      yield ending && ending.seq > last
        ? ending
        : {
            seq: last,
            data: { type: 'finished', status: run.status as RunStatus },
          };
      return;
    }

    for await (const event of live.values()) {
      if (event.seq <= last) continue;
      yield event;
      last = event.seq;
      if (event.data.type === 'finished') return;
    }
  }

  /** Changes to the user's runs, for the activity list and the counter in the header. */
  async *watch(
    userId: number,
    signal: AbortSignal,
  ): AsyncGenerator<ActivityNotice> {
    const notices = channel<RunNotice>(signal);
    notices.onClose(this.bus.watch(userId, (n) => notices.push(n)));
    yield { type: 'ready' };
    for await (const notice of notices.values()) {
      if (notice.type === 'activity') {
        yield notice;
        continue;
      }
      const run = await this.prisma.run.findFirst({
        where: { id: notice.runId, userId },
        include: { project: { select: { name: true } }, mission: { select: { title: true } } },
      });
      if (run) yield { type: 'run', run: this.view(run) };
    }
  }

  /** Stops a running run, or cancels one that hasn't started. */
  async abort(userId: number, id: number) {
    const run = await this.find(userId, id);
    if (this.executor.stop(id)) return;
    if (await this.log.close(run, ['queued', 'waiting'], 'aborted')) {
      this.queue.wake();
    }
  }

  async resume(userId: number, id: number) {
    const run = await this.find(userId, id);
    if (run.status !== 'interrupted' && run.status !== 'failed') {
      throw new ConflictException(
        "Si riprende solo un'esecuzione interrotta o fallita",
      );
    }
    const handler = this.handlers.get(run.kind);
    if (!handler.resume) {
      throw new BadRequestException(
        'Questa esecuzione non si può riprendere: invia di nuovo il messaggio',
      );
    }
    return handler.resume(run);
  }

  async seen(userId: number, id: number) {
    await this.find(userId, id);
    await this.prisma.run.update({
      where: { id },
      data: { seenAt: new Date() },
    });
    this.bus.notify(userId, { type: 'changed', runId: id });
  }
}
