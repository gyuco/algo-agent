import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { ConnectionsService } from '../connections/connections.service.js';
import type { Prisma, Run } from '../generated/prisma/client.js';
import { BudgetGuard } from '../missions/budget-guard.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { blockedBy, rateLimitedUntil, type RunSlot } from './limits.js';
import { RunConfig } from './run-config.js';
import { RunEventBus } from './run-event-bus.js';
import { RunExecutorService } from './run-executor.service.js';
import type { WaitReason } from './run-types.js';

/** Safety net in case a wake-up is missed, and to notice plan limits that reset. */
const TICK_MS = 5_000;

const sameReason = (a?: WaitReason, b?: WaitReason) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The queue of runs: takes them in order of arrival and starts each one the limits allow. */
@Injectable()
export class RunQueueService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(RunQueueService.name);
  /** Why each queued run is waiting, as of the last pass. */
  private readonly reasons = new Map<number, WaitReason>();
  /** Runs created but not ready to start yet. */
  private readonly preparing = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private passing = false;
  private again = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: RunConfig,
    private readonly bus: RunEventBus,
    private readonly executor: RunExecutorService,
    private readonly connections: ConnectionsService,
    private readonly budget: BudgetGuard,
  ) {}

  /** Called once recovery has closed what the previous process left running. */
  start() {
    this.timer = setInterval(() => this.wake(), TICK_MS);
    this.timer.unref();
    this.wake();
  }

  reason(runId: number): WaitReason | null {
    return this.reasons.get(runId) ?? null;
  }

  /**
   * Queues a new run. `prepare` runs before the scheduler can see it, e.g. to
   * store its attachments. Refuses with 429 past the user's queue limit.
   */
  async enqueue(
    data: Omit<Prisma.RunUncheckedCreateInput, 'status'>,
    prepare?: (run: Run) => Promise<void>,
  ) {
    const queued = await this.prisma.run.count({
      where: { userId: data.userId, status: 'queued' },
    });
    if (queued >= this.config.limits().queuedPerUser) {
      throw new HttpException(
        'Troppe esecuzioni in coda: attendi che alcune finiscano',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const run = await this.prisma.run.create({
      data: { ...data, status: 'queued' },
    });
    // A pass may come in meanwhile: it skips the run until it's prepared.
    this.preparing.add(run.id);
    try {
      await prepare?.(run);
    } catch (error) {
      await this.prisma.run.delete({ where: { id: run.id } });
      throw error;
    } finally {
      this.preparing.delete(run.id);
    }
    this.bus.notify(run.userId, { type: 'changed', runId: run.id });
    this.wake();
    return run;
  }

  /** Runs a scheduling pass now, or right after the one in progress. */
  wake() {
    if (this.stopped) return;
    if (this.passing) {
      this.again = true;
      return;
    }
    this.passing = true;
    void this.pass()
      .catch((error: unknown) =>
        this.logger.error(`Scheduling failed: ${String(error)}`),
      )
      .finally(() => {
        this.passing = false;
        if (this.again) {
          this.again = false;
          this.wake();
        }
      });
  }

  private async pass() {
    const [queued, running] = await Promise.all([
      this.prisma.run.findMany({
        where: { status: 'queued' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.run.findMany({
        where: { status: 'running' },
        select: { userId: true, projectId: true, kind: true, writes: true },
      }),
    ]);
    const slots: RunSlot[] = [...running];
    const limits = this.config.limits();
    const planLimits = new Map<string, string | null>();
    const reasons = new Map<number, WaitReason>();

    for (const run of queued) {
      if (this.stopped) return;
      if (this.preparing.has(run.id)) continue;
      const reason =
        blockedBy(run, slots, limits) ??
        (await this.planLimit(run, planLimits)) ??
        (await this.budgetLimit(run));
      if (reason) {
        reasons.set(run.id, reason);
        continue;
      }
      const now = new Date();
      const { count } = await this.prisma.run.updateMany({
        where: { id: run.id, status: 'queued' },
        // A run back from waiting keeps the time it first started.
        data: {
          status: 'running',
          startedAt: run.startedAt ?? now,
          heartbeatAt: now,
        },
      });
      if (!count) continue;
      slots.push(run);
      this.executor.start(
        {
          ...run,
          status: 'running',
          startedAt: run.startedAt ?? now,
          heartbeatAt: now,
        },
        () => this.wake(),
      );
      this.bus.notify(run.userId, { type: 'changed', runId: run.id });
    }

    // Tell lists about runs whose reason to wait changed.
    for (const run of queued) {
      if (!sameReason(this.reasons.get(run.id), reasons.get(run.id))) {
        this.bus.notify(run.userId, { type: 'changed', runId: run.id });
      }
    }
    this.reasons.clear();
    for (const [id, reason] of reasons) this.reasons.set(id, reason);
  }

  /** Holds back runs of a provider whose plan limit is used up, instead of letting them fail. */
  private async planLimit(
    run: Run,
    cache: Map<string, string | null>,
  ): Promise<WaitReason | null> {
    if (!run.provider) return null;
    const key = `${run.userId}:${run.provider}`;
    if (!cache.has(key)) {
      const connection = await this.connections.find(run.userId, run.provider);
      cache.set(key, rateLimitedUntil(connection?.state.rateLimits));
    }
    const until = cache.get(key);
    return until ? { code: 'rateLimit', until } : null;
  }

  /** The mission budget: only the kinds that spend Claude quota are gated. */
  private async budgetLimit(run: Run): Promise<WaitReason | null> {
    if (run.kind !== 'mission-orchestrator' && run.kind !== 'mission-task') {
      return null;
    }
    if (!run.missionId) return null;
    const gate = await this.budget.gate(run.missionId, run.model ?? undefined);
    if (gate.ok) return null;
    return {
      code: 'budget',
      kind: gate.kind,
      ...('until' in gate && gate.until ? { until: gate.until } : {}),
    };
  }

  /** Stops taking runs, then gives the running ones time to finish. */
  async beforeApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.executor.drain(this.config.shutdownGraceMs());
  }
}
