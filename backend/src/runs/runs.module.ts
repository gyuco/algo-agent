import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { RunConfig } from './run-config.js';
import { RunEventBus } from './run-event-bus.js';
import { RunExecutorService } from './run-executor.service.js';
import { RunFiles } from './run-files.js';
import { RunHandlers } from './run-handlers.js';
import { RunLog } from './run-log.js';
import { RunQueueService } from './run-queue.service.js';
import { RunRecoveryService } from './run-recovery.service.js';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';

/** Background runs: queue, executor, event log and the routes to follow them. */
@Module({
  imports: [ConnectionsModule],
  controllers: [RunsController],
  providers: [
    RunConfig,
    RunEventBus,
    RunExecutorService,
    RunFiles,
    RunHandlers,
    RunLog,
    RunQueueService,
    RunRecoveryService,
    RunsService,
  ],
  exports: [RunHandlers, RunQueueService, RunFiles, RunsService],
})
export class RunsModule {}
