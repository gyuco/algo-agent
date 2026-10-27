import { Module } from '@nestjs/common';
import { AppMcpModule } from '../app-mcp/app-mcp.module.js';
import { ConnectionsModule } from '../connections/connections.module.js';
import { OpencodeController } from './opencode.controller.js';
import { OpencodeProvider } from './opencode.provider.js';

@Module({
  imports: [ConnectionsModule, AppMcpModule],
  controllers: [OpencodeController],
  providers: [OpencodeProvider],
  exports: [OpencodeProvider],
})
export class OpencodeModule {}
