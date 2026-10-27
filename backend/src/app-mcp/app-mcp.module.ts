import { Module } from '@nestjs/common';
import { AppMcpController } from './app-mcp.controller.js';
import { AppMcpService } from './app-mcp.service.js';

@Module({
  controllers: [AppMcpController],
  providers: [AppMcpService],
  exports: [AppMcpService],
})
export class AppMcpModule {}
