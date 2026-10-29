import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { RunQueueService } from '../runs/run-queue.service.js';
import { BudgetGuard } from './budget-guard.service.js';
import { MissionScheduler } from './mission-scheduler.service.js';
import { MissionsService } from './missions.service.js';

const DEFAULT_TICK_MS = 60_000;
/** A window's reset is only trusted once it has passed by this much. */
const MARGIN_MS = 30_000;

interface Wait {
  code?: string;
  scope?: 'mission' | 'global';
  until?: string;
}

/** §2.6: the automatic resume of `paused` missions and the requeue of budget-waiting runs. */
@Injectable()
export class BudgetResumeService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(BudgetResumeService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly budget: BudgetGuard,
    private readonly queue: RunQueueService,
    private readonly scheduler: MissionScheduler,
    private readonly missions: MissionsService,
  ) {}

  onApplicationBootstrap() {
    const value = Number(this.config.get<string>('MISSIONS_BUDGET_TICK_MS'));
    const ms = Number.isInteger(value) && value > 0 ? value : DEFAULT_TICK_MS;
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.resumePaused();
      await this.resumeGlobal();
      await this.requeueRuns();
    } catch (error) {
      this.logger.error(
        `Budget resume failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  /** A five-hour or model window that reset: the mission goes on, and says so. */
  private async resumePaused() {
    const paused = await this.prisma.mission.findMany({
      where: { status: 'paused' },
      select: { id: true, userId: true, waitJson: true, orchestratorModel: true },
    });
    for (const mission of paused) {
      const wait = mission.waitJson
        ? (JSON.parse(mission.waitJson) as Wait)
        : null;
      const until = wait?.until ? Date.parse(wait.until) : Number.NaN;
      // Until the reset is near, the window can't be trusted: no probing.
      if (!Number.isFinite(until) || Date.now() < until + MARGIN_MS) continue;

      const gate = await this.budget.gate(mission.id, mission.orchestratorModel);
      if (gate.ok) {
        const { count } = await this.prisma.mission.updateMany({
          where: { id: mission.id, status: 'paused' },
          data: { status: 'running', waitJson: null },
        });
        if (!count) continue;
        await this.missions.record(
          mission.id,
          'resume',
          { code: wait?.code ?? 'five_hour' },
          { notify: true },
        );
        this.scheduler.wake(mission.id);
        continue;
      }
      // Still below the threshold, maybe with a new window: show the new reset, quietly.
      if (!gate.ok && 'until' in gate && gate.until !== wait?.until) {
        await this.prisma.mission.updateMany({
          where: { id: mission.id, status: 'paused' },
          data: {
            waitJson: JSON.stringify({ ...wait, until: gate.until }),
          },
        });
      }
    }
  }

  /** The global weekly cap lifts by itself at the weekly reset. */
  private async resumeGlobal() {
    const waiting = await this.prisma.mission.findMany({
      where: { status: 'waiting' },
      select: { id: true, waitJson: true },
    });
    for (const mission of waiting) {
      const wait = mission.waitJson
        ? (JSON.parse(mission.waitJson) as Wait)
        : null;
      if (wait?.code !== 'weekly_budget' || wait.scope !== 'global') continue;
      const until = wait.until ? Date.parse(wait.until) : Number.NaN;
      if (Number.isFinite(until) && Date.now() < until + MARGIN_MS) continue;
      const { count } = await this.prisma.mission.updateMany({
        where: { id: mission.id, status: 'waiting' },
        data: { status: 'running', waitJson: null },
      });
      if (!count) continue;
      await this.missions.record(
        mission.id,
        'resume',
        { code: 'weekly_budget' },
        { notify: true },
      );
      this.scheduler.wake(mission.id);
    }
  }

  /** Task runs stopped between steps go back to the queue once the gate opens. */
  private async requeueRuns() {
    const runs = await this.prisma.run.findMany({
      where: { kind: 'mission-task', status: 'waiting' },
      select: { id: true, missionId: true, model: true },
    });
    let woke = false;
    for (const run of runs) {
      if (!run.missionId) continue;
      const gate = await this.budget.gate(run.missionId, run.model ?? undefined);
      if (!gate.ok) continue;
      const { count } = await this.prisma.run.updateMany({
        where: { id: run.id, status: 'waiting' },
        data: { status: 'queued' },
      });
      if (count) woke = true;
    }
    if (woke) this.queue.wake();
  }
}
