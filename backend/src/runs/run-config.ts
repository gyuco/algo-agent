import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import type { RunLimits } from './limits.js';

/** Settings of background runs, from the environment, with cautious defaults. */
@Injectable()
export class RunConfig {
  constructor(private readonly config: ConfigService) {}

  private int(name: string, fallback: number) {
    const value = Number(this.config.get<string>(name));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  limits(): RunLimits {
    return {
      concurrent: this.int('RUNS_MAX_CONCURRENT', 6),
      workflowsPerUser: this.int('RUNS_MAX_WORKFLOWS_PER_USER', 2),
      chatsPerUser: this.int('RUNS_MAX_CHATS_PER_USER', 3),
      writersPerProject: this.int('RUNS_MAX_WRITERS_PER_PROJECT', 1),
      queuedPerUser: this.int('RUNS_MAX_QUEUED_PER_USER', 20),
    };
  }

  /** A running run whose heartbeat is older than this lost its process. */
  leaseMs() {
    return this.int('RUNS_LEASE_MS', 60_000);
  }

  /** How long shutting down waits for running runs before stopping them. */
  shutdownGraceMs() {
    return this.int('RUNS_SHUTDOWN_GRACE_MS', 30_000);
  }

  eventsRetentionDays() {
    return this.int('RUN_EVENTS_RETENTION_DAYS', 14);
  }

  /** Where runs keep files between the request and their start, e.g. chat attachments. */
  dataDir() {
    return this.config.get<string>('DATA_DIR') || join(process.cwd(), 'data');
  }
}
