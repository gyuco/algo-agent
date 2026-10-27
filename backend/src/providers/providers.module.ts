import { Module } from '@nestjs/common';
import { ClaudeModule } from '../claude/claude.module.js';
import { ClaudeProvider } from '../claude/claude.provider.js';
import { ConnectionsModule } from '../connections/connections.module.js';
import { OpencodeModule } from '../opencode/opencode.module.js';
import { OpencodeProvider } from '../opencode/opencode.provider.js';
import type { AgentProvider } from './provider.js';
import { ProvidersController } from './providers.controller.js';
import { AGENT_PROVIDERS, ProvidersService } from './providers.service.js';

/** The providers offered, in order: the first one connected is the default. Add new ones here. */
const PROVIDERS = [ClaudeProvider, OpencodeProvider];

@Module({
  imports: [ConnectionsModule, ClaudeModule, OpencodeModule],
  controllers: [ProvidersController],
  providers: [
    {
      provide: AGENT_PROVIDERS,
      useFactory: (...providers: AgentProvider[]) => providers,
      inject: PROVIDERS,
    },
    ProvidersService,
  ],
  exports: [ProvidersService],
})
export class ProvidersModule {}
