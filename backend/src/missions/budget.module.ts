import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { BudgetGuard } from './budget-guard.service.js';

/**
 * The mission budget, kept apart from `MissionsModule` so the run executor can
 * record tokens without a circular module dependency.
 */
@Module({
  imports: [ConnectionsModule, ProvidersModule],
  providers: [BudgetGuard],
  exports: [BudgetGuard],
})
export class BudgetModule {}
