import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { ClaudeController } from './claude.controller.js';
import { ClaudeProvider } from './claude.provider.js';

@Module({
  imports: [ConnectionsModule],
  controllers: [ClaudeController],
  providers: [ClaudeProvider],
  exports: [ClaudeProvider],
})
export class ClaudeModule {}
