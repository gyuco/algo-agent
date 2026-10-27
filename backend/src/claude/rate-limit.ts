import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';

export type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

export interface RateLimitWindow {
  /** Fraction of the window used, 0-1. */
  utilization: number | null;
  resetsAt: string | null;
  status: RateLimitStatus | null;
}

/** Plan usage as last reported by Claude Code, the data behind `/usage`. */
export interface RateLimitSnapshot {
  status: RateLimitStatus;
  windows: Record<string, RateLimitWindow>;
  overage: { status: RateLimitStatus | null; disabledReason: string | null };
  observedAt: string;
}

// Not in the SDK's types yet, but sent by current CLIs: every window at once.
type UnifiedWindows = Record<
  string,
  { utilization?: number; resetsAt?: number; status?: RateLimitStatus }
>;

const isoFromEpoch = (seconds?: number) =>
  typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;

export function toRateLimitSnapshot(
  info: SDKRateLimitInfo & { unifiedWindows?: UnifiedWindows },
  observedAt = new Date(),
): RateLimitSnapshot {
  const windows: Record<string, RateLimitWindow> = {};
  for (const [name, w] of Object.entries(info.unifiedWindows ?? {})) {
    windows[name] = {
      utilization: w.utilization ?? null,
      resetsAt: isoFromEpoch(w.resetsAt),
      status: w.status ?? null,
    };
  }
  // Older CLIs report only the window that triggered the event.
  if (info.rateLimitType && !windows[info.rateLimitType]) {
    windows[info.rateLimitType] = {
      utilization: info.utilization ?? null,
      resetsAt: isoFromEpoch(info.resetsAt),
      status: info.status,
    };
  }
  return {
    status: info.status,
    windows,
    overage: {
      status: info.overageStatus ?? null,
      disabledReason: info.overageDisabledReason ?? null,
    },
    observedAt: observedAt.toISOString(),
  };
}
