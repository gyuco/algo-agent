import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Mission, Run } from '../generated/prisma/client.js';
import { ConnectionsService } from '../connections/connections.service.js';
import type { RateLimitSnapshot } from '../claude/rate-limit.js';
import { parseRef } from '../providers/model-ref.js';
import { ProvidersService } from '../providers/providers.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { weightOf, type TokenUsage } from './model-weights.js';
import { planSchema } from './plan-schema.js';

/** The thresholds a mission uses: from the plan, or chosen by the user at approval. */
export interface BudgetThresholds {
  fiveHourMinRemaining: number;
  weeklyMaxShare: number;
  maxUsd?: number;
}

/** `Mission.budgetJson`, completed with the defaults of old missions. */
export interface MissionBudget extends BudgetThresholds {
  weekly: {
    /** Share of the week used since the mission started (0-1). */
    used: number;
    /** `weeklyMaxShare` times one plus the Continues. */
    allowance: number;
    week: { resetsAt: string; used: number };
  };
  usd: { allowance?: number };
}

export type BudgetGate =
  | { ok: true; uncontrollable?: true }
  | { ok: false; kind: 'five_hour'; until: string }
  | { ok: false; kind: 'model_window'; window: string; until: string }
  | { ok: false; kind: 'weekly_mission' }
  | { ok: false; kind: 'weekly_global'; until: string }
  | { ok: false; kind: 'usd' };

export interface BudgetView {
  source: 'plan' | 'api_key' | 'none';
  observedAt: string | null;
  fiveHour?: { used: number; threshold: number; resetsAt: string };
  week?: {
    used: number;
    resetsAt: string;
    missionUsed: number;
    missionAllowance: number;
    globalUsed: number;
    globalCap: number;
  };
  usd: { spent: number; allowance?: number };
  estimate: true;
}

const DEFAULT_FIVE_HOUR = 0.1;
const DEFAULT_WEEKLY_SHARE = 0.3;
const DEFAULT_GLOBAL_SHARE = 0.6;
const DEFAULT_STALE_MS = 300_000;
const REFRESH_GAP_MS = 300_000;

/** The budget of a mission, with the defaults of missions approved before phase 4. */
export function readBudget(
  mission: Pick<Mission, 'budgetJson' | 'planJson'>,
): MissionBudget {
  let saved: Partial<MissionBudget> = {};
  try {
    saved = JSON.parse(mission.budgetJson || '{}') as Partial<MissionBudget>;
  } catch {
    saved = {};
  }
  const plan = mission.planJson
    ? planSchema.safeParse(JSON.parse(mission.planJson))
    : null;
  const fromPlan = plan?.success ? plan.data.budget : null;
  const fiveHourMinRemaining =
    typeof saved.fiveHourMinRemaining === 'number'
      ? saved.fiveHourMinRemaining
      : (fromPlan?.fiveHourMinRemaining ?? DEFAULT_FIVE_HOUR);
  const weeklyMaxShare =
    typeof saved.weeklyMaxShare === 'number'
      ? saved.weeklyMaxShare
      : (fromPlan?.weeklyMaxShare ?? DEFAULT_WEEKLY_SHARE);
  const maxUsd =
    typeof saved.maxUsd === 'number' ? saved.maxUsd : fromPlan?.maxUsd;
  return {
    fiveHourMinRemaining,
    weeklyMaxShare,
    ...(maxUsd !== undefined ? { maxUsd } : {}),
    weekly: {
      used: saved.weekly?.used ?? 0,
      allowance: saved.weekly?.allowance ?? weeklyMaxShare,
      week: {
        resetsAt: saved.weekly?.week?.resetsAt ?? '',
        used: saved.weekly?.week?.used ?? 0,
      },
    },
    usd:
      saved.usd?.allowance !== undefined
        ? { allowance: saved.usd.allowance }
        : maxUsd !== undefined
          ? { allowance: maxUsd }
          : {},
  };
}

/** The initial `budgetJson` of a mission approved now. */
export function initialBudget(thresholds: BudgetThresholds): MissionBudget {
  return {
    ...thresholds,
    weekly: {
      used: 0,
      allowance: thresholds.weeklyMaxShare,
      week: { resetsAt: '', used: 0 },
    },
    usd:
      thresholds.maxUsd !== undefined
        ? { allowance: thresholds.maxUsd }
        : {},
  };
}

/**
 * New thresholds for a mission already under way: the share used and the
 * Continues granted stay, the allowances move by the change of the thresholds.
 */
export function rethresholdBudget(
  budget: MissionBudget,
  thresholds: BudgetThresholds,
): MissionBudget {
  const weeklyAllowance =
    budget.weekly.allowance - budget.weeklyMaxShare + thresholds.weeklyMaxShare;
  const usdAllowance =
    thresholds.maxUsd === undefined
      ? undefined
      : budget.maxUsd === undefined || budget.usd.allowance === undefined
        ? thresholds.maxUsd
        : budget.usd.allowance - budget.maxUsd + thresholds.maxUsd;
  return {
    ...thresholds,
    weekly: {
      ...budget.weekly,
      allowance: Math.max(thresholds.weeklyMaxShare, weeklyAllowance),
    },
    usd:
      usdAllowance !== undefined
        ? { allowance: Math.max(thresholds.maxUsd!, usdAllowance) }
        : {},
  };
}

/** One more allowance, as "Continua" grants. */
export function continueBudget(budget: MissionBudget): MissionBudget {
  const maxUsd = budget.maxUsd;
  return {
    ...budget,
    weekly: {
      ...budget.weekly,
      allowance: budget.weekly.allowance + budget.weeklyMaxShare,
    },
    usd:
      maxUsd !== undefined
        ? { allowance: (budget.usd.allowance ?? maxUsd) + maxUsd }
        : budget.usd,
  };
}

/** Whether the five-hour window is below half the threshold: the session must stop. */
export function shouldInterrupt(
  snapshot: RateLimitSnapshot | null | undefined,
  fiveHourMinRemaining: number,
): boolean {
  const used = snapshot?.windows.five_hour?.utilization;
  if (used == null) return false;
  const remaining = 1 - used;
  return remaining < fiveHourMinRemaining / 2;
}

interface WeightEntry {
  runId: number;
  userId: number;
  missionId: number | null;
  weight: number;
}

/**
 * The mission budget: the gate before new work, the interruption of a session
 * that runs out of the five-hour window, and the attribution of the weekly
 * quota to the missions by the tokens their sessions used.
 */
@Injectable()
export class BudgetGuard {
  private readonly logger = new Logger(BudgetGuard.name);
  /** Weight of every run in the current snapshot interval. In memory: a restart loses one interval. */
  private readonly weights = new Map<number, WeightEntry>();
  private readonly refreshing = new Map<number, Promise<void>>();
  private readonly lastRefresh = new Map<number, number>();
  /** Serializes the attributions, so two snapshots don't lose an increment. */
  private attributing: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly providers: ProvidersService,
    private readonly connections: ConnectionsService,
  ) {}

  private staleMs() {
    const value = Number(this.config.get<string>('MISSIONS_USAGE_STALE_MS'));
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_STALE_MS;
  }

  private globalCap() {
    const value = Number(this.config.get<string>('MISSIONS_WEEKLY_MAX_SHARE'));
    return typeof value === 'number' && value > 0 && value <= 1
      ? value
      : DEFAULT_GLOBAL_SHARE;
  }

  /** Only Claude sessions have plan windows: other models always pass. */
  private isClaude(model: string | undefined) {
    if (!model) return true;
    return parseRef(model, this.providers.ids()).provider === 'claude';
  }

  private async snapshotOf(
    userId: number,
  ): Promise<{ snapshot: RateLimitSnapshot | null; method: string | null }> {
    const connection = await this.connections.find(userId, 'claude');
    const snapshot =
      (connection?.state.rateLimits as RateLimitSnapshot | null) ?? null;
    if (snapshot && this.isStale(snapshot)) await this.refresh(userId);
    if (!snapshot || this.isStale(snapshot)) {
      const fresh = await this.connections.find(userId, 'claude');
      return {
        snapshot:
          (fresh?.state.rateLimits as RateLimitSnapshot | null) ?? snapshot,
        method: fresh?.method ?? connection?.method ?? null,
      };
    }
    return { snapshot, method: connection?.method ?? null };
  }

  private isStale(snapshot: RateLimitSnapshot) {
    const at = Date.parse(snapshot.observedAt);
    return !Number.isFinite(at) || Date.now() - at > this.staleMs();
  }

  /** Asks the provider for a fresh window, at most once every five minutes per user. */
  private refresh(userId: number): Promise<void> {
    const running = this.refreshing.get(userId);
    if (running) return running;
    const last = this.lastRefresh.get(userId) ?? 0;
    if (Date.now() - last < REFRESH_GAP_MS) return Promise.resolve();
    this.lastRefresh.set(userId, Date.now());
    const task = (async () => {
      try {
        const provider = this.providers.get('claude');
        await provider.refreshUsage?.(userId);
      } catch (error) {
        // The last figures are used: a stale one is better than none.
        this.logger.warn(
          `Claude usage refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.refreshing.delete(userId);
      }
    })();
    this.refreshing.set(userId, task);
    return task;
  }

  /** Whether new Claude work of this mission may start now. */
  async gate(missionId: number, model?: string): Promise<BudgetGate> {
    const mission = await this.prisma.mission.findUnique({
      where: { id: missionId },
    });
    if (!mission || !this.isClaude(model)) return { ok: true };
    const budget = readBudget(mission);
    const { snapshot } = await this.snapshotOf(mission.userId);

    if (!snapshot) {
      const allowance = budget.usd.allowance;
      if (allowance === undefined) return { ok: true, uncontrollable: true };
      return mission.costUsd >= allowance ? { ok: false, kind: 'usd' } : { ok: true };
    }

    const fallbackUntil = new Date(Date.now() + 5 * 60_000).toISOString();
    const five = snapshot.windows.five_hour;
    if (five?.utilization != null) {
      const remaining = 1 - five.utilization;
      if (remaining < budget.fiveHourMinRemaining) {
        return {
          ok: false,
          kind: 'five_hour',
          until: five.resetsAt ?? fallbackUntil,
        };
      }
    }

    const window = model ? this.modelWindow(snapshot, model) : null;
    if (window) {
      return {
        ok: false,
        kind: 'model_window',
        window: window.name,
        until: window.resetsAt ?? fallbackUntil,
      };
    }

    if (budget.weekly.used >= budget.weekly.allowance) {
      return { ok: false, kind: 'weekly_mission' };
    }

    const week = snapshot.windows.seven_day;
    const globalUsed = await this.globalUsed(
      mission.userId,
      week?.resetsAt ?? null,
    );
    if (globalUsed >= this.globalCap()) {
      return {
        ok: false,
        kind: 'weekly_global',
        until: week?.resetsAt ?? fallbackUntil,
      };
    }

    if (budget.usd.allowance !== undefined && mission.costUsd >= budget.usd.allowance) {
      return { ok: false, kind: 'usd' };
    }
    return { ok: true };
  }

  private modelWindow(snapshot: RateLimitSnapshot, model: string) {
    const family = /opus/i.test(model)
      ? 'opus'
      : /haiku/i.test(model)
        ? 'haiku'
        : 'sonnet';
    const name = `seven_day_${family}`;
    const window = snapshot.windows[name];
    if (!window) return null;
    const exhausted =
      window.status === 'rejected' || (window.utilization ?? 0) >= 0.98;
    return exhausted ? { name, resetsAt: window.resetsAt } : null;
  }

  /** The share of the week the user's missions used in the window that ends at `resetsAt`. */
  async globalUsed(userId: number, resetsAt: string | null) {
    if (!resetsAt) return 0;
    const missions = await this.prisma.mission.findMany({
      where: { userId },
      select: { budgetJson: true, planJson: true },
    });
    return missions.reduce((sum, mission) => {
      const budget = readBudget(mission);
      return budget.weekly.week.resetsAt === resetsAt
        ? sum + budget.weekly.week.used
        : sum;
    }, 0);
  }

  /** The tokens of one assistant message: part of the session's weight for the interval. */
  recordTokens(run: Run, tokens: TokenUsage) {
    const weight = weightOf(tokens);
    if (!(weight > 0)) return;
    const entry = this.weights.get(run.id) ?? {
      runId: run.id,
      userId: run.userId,
      missionId: run.missionId ?? null,
      weight: 0,
    };
    entry.weight += weight;
    this.weights.set(run.id, entry);
  }

  /** At the end of a session the real cost replaces the estimate for the run. */
  calibrate(runId: number, costUsd: number) {
    const entry = this.weights.get(runId);
    if (!entry || !(costUsd > 0)) return;
    entry.weight = costUsd;
  }

  /**
   * A new plan snapshot: the growth of the weekly window is divided among the
   * runs of the interval by weight, and each mission's part is added to it.
   */
  snapshot(userId: number, snapshot: RateLimitSnapshot | null | undefined) {
    if (!snapshot) return Promise.resolve();
    const week = snapshot.windows.seven_day;
    const utilization = week?.utilization;
    if (utilization == null) return Promise.resolve();
    const resetsAt = week?.resetsAt ?? null;
    this.attributing = this.attributing
      .then(() => this.attribute(userId, snapshot, utilization, resetsAt))
      .catch((error: unknown) =>
        this.logger.warn(
          `Weekly budget attribution failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    return this.attributing;
  }

  private async attribute(
    userId: number,
    snapshot: RateLimitSnapshot,
    utilization: number,
    resetsAt: string | null,
  ) {
    const connection = await this.connections.find(userId, 'claude');
    if (!connection) return;
    const cursor = connection.state.budgetCursor as
      | { utilization: number; resetsAt: string | null }
      | undefined;
    // A changed reset means the week turned over: the whole window is new.
    const growth =
      cursor && cursor.resetsAt && resetsAt && cursor.resetsAt === resetsAt
        ? Math.max(0, utilization - cursor.utilization)
        : utilization;

    const mine = [...this.weights.values()].filter((w) => w.userId === userId);
    const total = mine.reduce((sum, w) => sum + w.weight, 0);
    if (growth > 0 && total > 0) {
      const byMission = new Map<number, number>();
      for (const entry of mine) {
        if (entry.missionId === null) continue;
        const share = (growth * entry.weight) / total;
        byMission.set(
          entry.missionId,
          (byMission.get(entry.missionId) ?? 0) + share,
        );
      }
      for (const [missionId, share] of byMission) {
        await this.addWeekly(missionId, share, resetsAt);
      }
    }
    for (const id of mine.map((w) => w.runId)) this.weights.delete(id);
    await this.connections.updateState(userId, 'claude', {
      budgetCursor: {
        utilization,
        resetsAt,
        observedAt: snapshot.observedAt,
      },
    });
  }

  private async addWeekly(
    missionId: number,
    share: number,
    resetsAt: string | null,
  ) {
    const mission = await this.prisma.mission.findUnique({
      where: { id: missionId },
      select: { budgetJson: true, planJson: true },
    });
    if (!mission) return;
    const budget = readBudget(mission);
    const week =
      resetsAt && budget.weekly.week.resetsAt === resetsAt
        ? {
            resetsAt,
            used: budget.weekly.week.used + share,
          }
        : { resetsAt: resetsAt ?? '', used: share };
    await this.prisma.mission.update({
      where: { id: missionId },
      data: {
        budgetJson: JSON.stringify({
          ...budget,
          weekly: { ...budget.weekly, used: budget.weekly.used + share, week },
        }),
      },
    });
  }

  /** Whether the account reports plan windows at all: automatic mode needs a cap without them. */
  async hasPlanData(userId: number) {
    const { snapshot } = await this.snapshotOf(userId);
    return Boolean(snapshot);
  }

  /** What the mission's screen shows. */
  async view(missionId: number): Promise<BudgetView> {
    const mission = await this.prisma.mission.findUnique({
      where: { id: missionId },
    });
    if (!mission) {
      return {
        source: 'none',
        observedAt: null,
        usd: { spent: 0 },
        estimate: true,
      };
    }
    const budget = readBudget(mission);
    const { snapshot, method } = await this.snapshotOf(mission.userId);
    const source = snapshot
      ? 'plan'
      : method === 'api_key'
        ? 'api_key'
        : 'none';
    const five = snapshot?.windows.five_hour;
    const week = snapshot?.windows.seven_day;
    const globalUsed = await this.globalUsed(
      mission.userId,
      week?.resetsAt ?? null,
    );
    return {
      source,
      observedAt: snapshot?.observedAt ?? null,
      ...(five?.utilization != null && five.resetsAt
        ? {
            fiveHour: {
              used: five.utilization,
              threshold: budget.fiveHourMinRemaining,
              resetsAt: five.resetsAt,
            },
          }
        : {}),
      ...(week
        ? {
            week: {
              used: week.utilization ?? 0,
              resetsAt: week.resetsAt ?? '',
              missionUsed: budget.weekly.used,
              missionAllowance: budget.weekly.allowance,
              globalUsed,
              globalCap: this.globalCap(),
            },
          }
        : {}),
      usd: {
        spent: mission.costUsd,
        ...(budget.usd.allowance !== undefined
          ? { allowance: budget.usd.allowance }
          : {}),
      },
      estimate: true,
    };
  }

  /** The user's windows and the missions waiting on the budget, for the Activity page. */
  async userView(userId: number) {
    const { snapshot } = await this.snapshotOf(userId);
    const week = snapshot?.windows.seven_day;
    const five = snapshot?.windows.five_hour;
    const globalUsed = await this.globalUsed(
      userId,
      week?.resetsAt ?? null,
    );
    const missions = await this.prisma.mission.findMany({
      where: { userId, status: { in: ['running', 'paused', 'waiting'] } },
      select: {
        id: true,
        title: true,
        status: true,
        budgetJson: true,
        planJson: true,
        costUsd: true,
        waitJson: true,
      },
    });
    return {
      observedAt: snapshot?.observedAt ?? null,
      ...(five?.utilization != null && five.resetsAt
        ? {
            fiveHour: {
              used: five.utilization,
              resetsAt: five.resetsAt,
            },
          }
        : {}),
      ...(week
        ? {
            week: {
              used: week.utilization ?? 0,
              resetsAt: week.resetsAt ?? '',
              globalUsed,
              globalCap: this.globalCap(),
            },
          }
        : {}),
      estimate: true,
      missions: missions.map((mission) => {
        const budget = readBudget(mission);
        return {
          id: mission.id,
          title: mission.title,
          status: mission.status,
          wait: mission.waitJson
            ? (JSON.parse(mission.waitJson) as Record<string, unknown>)
            : null,
          budget: {
            weekly: budget.weekly,
            usd: { spent: mission.costUsd, ...budget.usd },
          },
        };
      }),
    };
  }
}
