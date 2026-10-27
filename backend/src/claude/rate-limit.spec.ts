import { toRateLimitSnapshot } from './rate-limit.js';

describe('toRateLimitSnapshot', () => {
  const observedAt = new Date('2026-10-27T12:00:00Z');

  it('reads every unified window', () => {
    const snapshot = toRateLimitSnapshot(
      {
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: 1793112600,
        overageStatus: 'rejected',
        overageDisabledReason: 'org_level_disabled',
        unifiedWindows: {
          five_hour: {
            utilization: 0.31,
            resetsAt: 1793112600,
            status: 'allowed',
          },
          seven_day: {
            utilization: 0.37,
            resetsAt: 1793523600,
            status: 'allowed',
          },
        },
      },
      observedAt,
    );
    expect(snapshot.windows.five_hour).toEqual({
      utilization: 0.31,
      resetsAt: new Date(1793112600 * 1000).toISOString(),
      status: 'allowed',
    });
    expect(snapshot.windows.seven_day.utilization).toBe(0.37);
    expect(snapshot.overage).toEqual({
      status: 'rejected',
      disabledReason: 'org_level_disabled',
    });
    expect(snapshot.observedAt).toBe(observedAt.toISOString());
  });

  it('falls back to the single reported window', () => {
    const snapshot = toRateLimitSnapshot(
      {
        status: 'allowed_warning',
        rateLimitType: 'seven_day',
        utilization: 0.9,
      },
      observedAt,
    );
    expect(snapshot.windows).toEqual({
      seven_day: {
        utilization: 0.9,
        resetsAt: null,
        status: 'allowed_warning',
      },
    });
  });
});
