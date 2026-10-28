import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RunEventBus } from './run-event-bus.js';
import type { RunEventData, RunStatus } from './run-types.js';

/**
 * Closes runs that aren't executing in this process (stopped while queued,
 * found interrupted): the final status, and the `finished` event every ended
 * run has last, so clients following it stop.
 */
@Injectable()
export class RunLog {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: RunEventBus,
  ) {}

  /** Appends one event after the run's last; only for runs nothing else writes to. */
  async append(runId: number, data: RunEventData) {
    const last = await this.prisma.runEvent.aggregate({
      where: { runId },
      _max: { seq: true },
    });
    const seq = (last._max.seq ?? 0) + 1;
    await this.prisma.runEvent.create({
      data: { runId, seq, dataJson: JSON.stringify(data) },
    });
    this.bus.publish(runId, { seq, data });
  }

  /**
   * Moves a run from one of `from` to a final status; false when it was no
   * longer in one of them, e.g. the scheduler took it meanwhile.
   */
  async close(
    run: { id: number; userId: number },
    from: RunStatus[],
    status: RunStatus,
    error: string | null = null,
  ) {
    const { count } = await this.prisma.run.updateMany({
      where: { id: run.id, status: { in: from } },
      data: { status, error, finishedAt: new Date(), heartbeatAt: null },
    });
    if (!count) return false;
    if (error) await this.append(run.id, { type: 'error', message: error });
    await this.append(run.id, { type: 'finished', status });
    this.bus.end(run.id);
    this.bus.notify(run.userId, { type: 'changed', runId: run.id });
    return true;
  }
}
