import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RunConfig } from './run-config.js';
import { RunExecutorService } from './run-executor.service.js';
import { RunFiles } from './run-files.js';
import { RunLog } from './run-log.js';
import { RunQueueService } from './run-queue.service.js';
import { readSteps } from './run-steps.js';

const CHECK_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Closes runs whose process is gone: at startup every running one, then any
 * whose heartbeat went stale. Closes runs left waiting for an approval too
 * long, and drops old event logs once a day.
 */
@Injectable()
export class RunRecoveryService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RunRecoveryService.name);
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: RunConfig,
    private readonly executor: RunExecutorService,
    private readonly log: RunLog,
    private readonly queue: RunQueueService,
    private readonly files: RunFiles,
  ) {}

  async onApplicationBootstrap() {
    // One instance: whatever is running now was left by the previous process.
    await this.interrupt(
      { status: 'running' },
      "Backend riavviato durante l'esecuzione",
    );
    await this.cleanUp();
    this.timers.push(
      setInterval(() => void this.checkLeases(), CHECK_MS),
      setInterval(() => void this.expireApprovals(), CHECK_MS),
      setInterval(() => void this.cleanUp(), DAY_MS),
    );
    this.timers.forEach((t) => t.unref());
    this.queue.start();
  }

  onApplicationShutdown() {
    this.timers.forEach((t) => clearInterval(t));
  }

  private async checkLeases() {
    const stale = new Date(Date.now() - this.config.leaseMs());
    await this.interrupt(
      { status: 'running', heartbeatAt: { lt: stale } },
      'Esecuzione interrotta',
    ).catch((error: unknown) =>
      this.logger.error(`Lease check failed: ${String(error)}`),
    );
  }

  /** Waiting runs whose oldest request for approval is past the timeout. */
  private async expireApprovals() {
    const timeoutMs = this.config.approvalTimeoutMs();
    const hours = Math.round(timeoutMs / 3_600_000);
    try {
      const runs = await this.prisma.run.findMany({
        where: { status: 'waiting' },
        select: { id: true, userId: true, stepsJson: true },
      });
      for (const run of runs) {
        const requested = Object.values(readSteps(run.stepsJson))
          .filter((s) => s.status === 'waiting_approval' && s.requestedAt)
          .map((s) => Date.parse(s.requestedAt!));
        if (!requested.length) continue;
        if (Date.now() - Math.min(...requested) < timeoutMs) continue;
        await this.log.close(
          run,
          ['waiting'],
          'aborted',
          `Nessuna approvazione entro ${hours} ore`,
        );
      }
    } catch (error) {
      this.logger.error(`Approval check failed: ${String(error)}`);
    }
  }

  private async interrupt(
    where: { status: string; heartbeatAt?: { lt: Date } },
    error: string,
  ) {
    const runs = await this.prisma.run.findMany({
      where,
      select: { id: true, userId: true },
    });
    for (const run of runs) {
      if (this.executor.isExecuting(run.id)) continue;
      if (await this.log.close(run, ['running'], 'interrupted', error)) {
        this.logger.warn(`Run ${run.id} interrupted: ${error}`);
      }
    }
  }

  /** The log of a run is for following and reviewing it; its steps stay in the run. */
  private async cleanUp() {
    const before = new Date(
      Date.now() - this.config.eventsRetentionDays() * DAY_MS,
    );
    const { count } = await this.prisma.runEvent.deleteMany({
      where: { run: { finishedAt: { lt: before } } },
    });
    if (count) this.logger.log(`Dropped ${count} old run events`);
    await this.files.cleanUp(before).catch((error: unknown) =>
      this.logger.warn(`Attachment cleanup failed: ${String(error)}`),
    );
  }
}
